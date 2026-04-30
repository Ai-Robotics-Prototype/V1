#include <rclcpp/rclcpp.hpp>
#include <sensor_msgs/msg/point_cloud2.hpp>
#include <sensor_msgs/point_cloud2_iterator.hpp>
#include <tf2_ros/buffer.h>
#include <tf2_ros/transform_listener.h>
#include <tf2_sensor_msgs/tf2_sensor_msgs.hpp>
#include <message_filters/subscriber.h>
#include <message_filters/sync_policies/approximate_time.h>
#include <message_filters/synchronizer.h>

#include "cuda_pointcloud/cuda_pointcloud.hpp"

#include <cuda_runtime.h>
#include <chrono>
#include <vector>
#include <memory>

using PointCloud2 = sensor_msgs::msg::PointCloud2;
using SyncPolicy  = message_filters::sync_policies::ApproximateTime<
  PointCloud2, PointCloud2, PointCloud2>;

class CudaPointcloudNode : public rclcpp::Node
{
public:
  CudaPointcloudNode() : Node("cuda_pointcloud_node")
  {
    declare_parameter("voxel_size",    0.025f);
    declare_parameter("min_range",     0.2f);
    declare_parameter("max_range",     5.0f);
    declare_parameter("target_frame",  std::string("base_link"));
    declare_parameter("estimate_normals", false);
    declare_parameter("k_neighbours",  20);
    declare_parameter("max_points",    500000);

    voxel_size_  = get_parameter("voxel_size").as_double();
    min_range_   = get_parameter("min_range").as_double();
    max_range_   = get_parameter("max_range").as_double();
    target_frame_= get_parameter("target_frame").as_string();
    do_normals_  = get_parameter("estimate_normals").as_bool();
    k_nn_        = get_parameter("k_neighbours").as_int();
    max_pts_     = get_parameter("max_points").as_int();

    tf_buffer_   = std::make_shared<tf2_ros::Buffer>(get_clock());
    tf_listener_ = std::make_shared<tf2_ros::TransformListener>(*tf_buffer_);

    // Pre-allocate GPU buffers
    cudaMalloc(&d_cloud_a_,   max_pts_ * sizeof(cuda_pc::Point4f));
    cudaMalloc(&d_cloud_b_,   max_pts_ * sizeof(cuda_pc::Point4f));
    cudaMalloc(&d_cloud_c_,   max_pts_ * sizeof(cuda_pc::Point4f));
    cudaMalloc(&d_merged_,    max_pts_ * sizeof(cuda_pc::Point4f));
    cudaMalloc(&d_filtered_,  max_pts_ * sizeof(cuda_pc::Point4f));
    cudaMalloc(&d_voxeled_,   max_pts_ * sizeof(cuda_pc::Point4f));
    if (do_normals_) {
      cudaMalloc(&d_normals_, max_pts_ * sizeof(cuda_pc::Normal4f));
    }
    cudaStreamCreate(&stream_);

    fused_pub_ = create_publisher<PointCloud2>("/perception/fused_cloud_gpu", 10);

    lidar_sub_.subscribe(this, "/lidar/points");
    cam0_sub_.subscribe(this,  "/cam0/depth/points");
    cam1_sub_.subscribe(this,  "/cam1/depth/points");

    sync_ = std::make_shared<message_filters::Synchronizer<SyncPolicy>>(
      SyncPolicy(10), lidar_sub_, cam0_sub_, cam1_sub_);
    sync_->setMaxIntervalDuration(rclcpp::Duration::from_seconds(0.05));
    sync_->registerCallback(
      std::bind(&CudaPointcloudNode::fusion_cb, this,
        std::placeholders::_1, std::placeholders::_2, std::placeholders::_3));

    RCLCPP_INFO(get_logger(),
      "cuda_pointcloud_node ready | voxel=%.3fm range=[%.1f,%.1f]m normals=%s",
      voxel_size_, min_range_, max_range_, do_normals_ ? "on" : "off");
  }

  ~CudaPointcloudNode()
  {
    cudaFree(d_cloud_a_); cudaFree(d_cloud_b_); cudaFree(d_cloud_c_);
    cudaFree(d_merged_);  cudaFree(d_filtered_); cudaFree(d_voxeled_);
    if (d_normals_) cudaFree(d_normals_);
    cudaStreamDestroy(stream_);
  }

private:
  // ── Convert ROS PointCloud2 → device Point4f array ───────────────────────
  std::size_t upload_cloud(const PointCloud2& msg, cuda_pc::Point4f* d_buf)
  {
    const std::size_t n = msg.width * msg.height;
    if (n == 0) return 0;

    // Build a host-side float4 buffer from the ROS message
    std::vector<cuda_pc::Point4f> h_pts(n);
    sensor_msgs::PointCloud2ConstIterator<float> it_x(msg, "x");
    sensor_msgs::PointCloud2ConstIterator<float> it_y(msg, "y");
    sensor_msgs::PointCloud2ConstIterator<float> it_z(msg, "z");

    bool has_intensity = false;
    for (const auto& f : msg.fields) {
      if (f.name == "intensity") { has_intensity = true; break; }
    }

    if (has_intensity) {
      sensor_msgs::PointCloud2ConstIterator<float> it_i(msg, "intensity");
      for (std::size_t i = 0; i < n; ++i, ++it_x, ++it_y, ++it_z, ++it_i) {
        h_pts[i] = {*it_x, *it_y, *it_z, *it_i};
      }
    } else {
      for (std::size_t i = 0; i < n; ++i, ++it_x, ++it_y, ++it_z) {
        h_pts[i] = {*it_x, *it_y, *it_z, 0.0f};
      }
    }

    const std::size_t clamped = std::min(n, static_cast<std::size_t>(max_pts_ / 3));
    cudaMemcpyAsync(d_buf, h_pts.data(),
      clamped * sizeof(cuda_pc::Point4f), cudaMemcpyHostToDevice, stream_);
    return clamped;
  }

  // ── TF2: transform cloud in-place (host side for now) ────────────────────
  PointCloud2 try_transform(const PointCloud2& in)
  {
    if (in.header.frame_id == target_frame_) return in;
    try {
      auto tf = tf_buffer_->lookupTransform(
        target_frame_, in.header.frame_id,
        tf2::TimePointZero, tf2::durationFromSec(0.1));
      PointCloud2 out;
      tf2::doTransform(in, out, tf);
      return out;
    } catch (const tf2::TransformException& e) {
      RCLCPP_WARN_THROTTLE(get_logger(), *get_clock(), 2000,
        "TF %s→%s: %s", in.header.frame_id.c_str(), target_frame_.c_str(), e.what());
      return in;
    }
  }

  // ── Download device Point4f → ROS PointCloud2 ────────────────────────────
  PointCloud2 download_cloud(const cuda_pc::Point4f* d_buf, std::size_t n)
  {
    std::vector<cuda_pc::Point4f> h_pts(n);
    cudaMemcpyAsync(h_pts.data(), d_buf,
      n * sizeof(cuda_pc::Point4f), cudaMemcpyDeviceToHost, stream_);
    cudaStreamSynchronize(stream_);

    PointCloud2 msg;
    msg.header.frame_id = target_frame_;
    msg.header.stamp    = get_clock()->now();
    msg.height = 1;
    msg.width  = static_cast<uint32_t>(n);
    msg.is_dense = false;
    msg.is_bigendian = false;

    sensor_msgs::PointCloud2Modifier mod(msg);
    mod.setPointCloud2FieldsByString(2, "xyz", "intensity");
    mod.resize(n);

    sensor_msgs::PointCloud2Iterator<float> ix(msg, "x");
    sensor_msgs::PointCloud2Iterator<float> iy(msg, "y");
    sensor_msgs::PointCloud2Iterator<float> iz(msg, "z");
    sensor_msgs::PointCloud2Iterator<float> ii(msg, "intensity");

    for (std::size_t i = 0; i < n; ++i, ++ix, ++iy, ++iz, ++ii) {
      *ix = h_pts[i].x; *iy = h_pts[i].y;
      *iz = h_pts[i].z; *ii = h_pts[i].intensity;
    }
    return msg;
  }

  void fusion_cb(
    const PointCloud2::ConstSharedPtr& lidar_msg,
    const PointCloud2::ConstSharedPtr& cam0_msg,
    const PointCloud2::ConstSharedPtr& cam1_msg)
  {
    auto t0 = std::chrono::steady_clock::now();

    // Transform to target frame
    auto lidar_t = try_transform(*lidar_msg);
    auto cam0_t  = try_transform(*cam0_msg);
    auto cam1_t  = try_transform(*cam1_msg);

    // Upload to GPU
    std::size_t na = upload_cloud(lidar_t, d_cloud_a_);
    std::size_t nb = upload_cloud(cam0_t,  d_cloud_b_);
    std::size_t nc = upload_cloud(cam1_t,  d_cloud_c_);

    // Concatenate
    const cuda_pc::Point4f* clouds[3] = {d_cloud_a_, d_cloud_b_, d_cloud_c_};
    const std::size_t       sizes[3]  = {na, nb, nc};
    std::size_t n_merged = 0;
    cuda_pc::concat_clouds(clouds, sizes, 3, d_merged_, &n_merged, stream_);

    // Range filter
    std::size_t n_filtered = 0;
    cuda_pc::range_filter(
      d_merged_, n_merged, d_filtered_, &n_filtered,
      min_range_, max_range_, stream_);

    // Voxel grid downsample
    std::size_t n_voxeled = 0;
    cuda_pc::voxel_grid_filter(
      d_filtered_, n_filtered, d_voxeled_, &n_voxeled,
      voxel_size_, stream_);

    // Optionally estimate normals
    if (do_normals_ && n_voxeled > 0) {
      cuda_pc::estimate_normals(d_voxeled_, n_voxeled, d_normals_, k_nn_, stream_);
    }

    cudaStreamSynchronize(stream_);

    // Publish
    auto out_msg = download_cloud(d_voxeled_, n_voxeled);
    fused_pub_->publish(out_msg);

    auto t1 = std::chrono::steady_clock::now();
    double ms = std::chrono::duration<double, std::milli>(t1 - t0).count();

    RCLCPP_INFO_THROTTLE(get_logger(), *get_clock(), 1000,
      "GPU fusion: %zu→%zu→%zu pts | %.1f ms", n_merged, n_filtered, n_voxeled, ms);
  }

  // ── Parameters ──────────────────────────────────────────────────────────────
  float       voxel_size_, min_range_, max_range_;
  std::string target_frame_;
  bool        do_normals_;
  int         k_nn_, max_pts_;

  // ── CUDA resources ───────────────────────────────────────────────────────────
  cuda_pc::Point4f*  d_cloud_a_  = nullptr;
  cuda_pc::Point4f*  d_cloud_b_  = nullptr;
  cuda_pc::Point4f*  d_cloud_c_  = nullptr;
  cuda_pc::Point4f*  d_merged_   = nullptr;
  cuda_pc::Point4f*  d_filtered_ = nullptr;
  cuda_pc::Point4f*  d_voxeled_  = nullptr;
  cuda_pc::Normal4f* d_normals_  = nullptr;
  cudaStream_t       stream_;

  // ── ROS ──────────────────────────────────────────────────────────────────────
  rclcpp::Publisher<PointCloud2>::SharedPtr fused_pub_;
  message_filters::Subscriber<PointCloud2> lidar_sub_, cam0_sub_, cam1_sub_;
  std::shared_ptr<message_filters::Synchronizer<SyncPolicy>> sync_;
  std::shared_ptr<tf2_ros::Buffer>            tf_buffer_;
  std::shared_ptr<tf2_ros::TransformListener> tf_listener_;
};

int main(int argc, char* argv[])
{
  rclcpp::init(argc, argv);
  rclcpp::spin(std::make_shared<CudaPointcloudNode>());
  rclcpp::shutdown();
  return 0;
}
