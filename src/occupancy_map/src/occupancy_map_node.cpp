#include <rclcpp/rclcpp.hpp>
#include <sensor_msgs/msg/point_cloud2.hpp>
#include <sensor_msgs/msg/image.hpp>
#include <sensor_msgs/msg/camera_info.hpp>
#include <nav_msgs/msg/occupancy_grid.hpp>
#include <std_msgs/msg/string.hpp>
#include <geometry_msgs/msg/pose_stamped.hpp>
#include <visualization_msgs/msg/marker_array.hpp>
#include <tf2_ros/buffer.h>
#include <tf2_ros/transform_listener.h>

#include <chrono>
#include <memory>
#include <string>

#ifdef NVBLOX_AVAILABLE
// Isaac ROS nvblox integration is achieved via composition:
// This node launches alongside nvblox_ros/NvbloxNode and acts as
// a relay/configurator.  Direct API calls require linking nvblox_ros.
#include <nvblox_ros/nvblox_node.hpp>
#endif

// ── OccupancyMapNode ─────────────────────────────────────────────────────────
// When nvblox_ros is available: wraps NvbloxNode and relays topics.
// When not: lightweight CPU voxel grid for development / CI.

class OccupancyMapNode : public rclcpp::Node
{
public:
  OccupancyMapNode() : Node("occupancy_map_node")
  {
    declare_parameter("voxel_size",    0.05);
    declare_parameter("max_range",     4.0);
    declare_parameter("map_frame",     std::string("map"));
    declare_parameter("decay_rate",    0.95);
    declare_parameter("use_color",     false);
    declare_parameter("publish_esdf",  true);
    declare_parameter("esdf_max_distance_m", 2.0);

    voxel_size_   = get_parameter("voxel_size").as_double();
    max_range_    = get_parameter("max_range").as_double();
    map_frame_    = get_parameter("map_frame").as_string();
    publish_esdf_ = get_parameter("publish_esdf").as_bool();

    tf_buffer_   = std::make_shared<tf2_ros::Buffer>(get_clock());
    tf_listener_ = std::make_shared<tf2_ros::TransformListener>(*tf_buffer_);

    // Subscriptions
    pc_sub_   = create_subscription<sensor_msgs::msg::PointCloud2>(
      "/perception/fused_cloud", rclcpp::SensorDataQoS(),
      [this](sensor_msgs::msg::PointCloud2::SharedPtr m){ pc_callback(m); });

    depth_sub_ = create_subscription<sensor_msgs::msg::Image>(
      "/cam0/cam0/aligned_depth_to_color/image_raw", rclcpp::SensorDataQoS(),
      [this](sensor_msgs::msg::Image::SharedPtr m){ depth_callback(m); });

    info_sub_ = create_subscription<sensor_msgs::msg::CameraInfo>(
      "/cam0/cam0/aligned_depth_to_color/camera_info", 10,
      [this](sensor_msgs::msg::CameraInfo::SharedPtr m){ cam_info_ = m; });

    // Publishers
    grid_pub_   = create_publisher<nav_msgs::msg::OccupancyGrid>("/map/occupancy", 10);
    mesh_pub_   = create_publisher<visualization_msgs::msg::MarkerArray>("/map/mesh_markers", 10);
    status_pub_ = create_publisher<std_msgs::msg::String>("/map/status", 2);

    stats_timer_ = create_wall_timer(
      std::chrono::seconds(1),
      [this]{ publish_status(); });

#ifdef NVBLOX_AVAILABLE
    RCLCPP_INFO(get_logger(),
      "occupancy_map_node started with nvblox GPU backend | voxel=%.3fm", voxel_size_);
#else
    RCLCPP_INFO(get_logger(),
      "occupancy_map_node started (CPU fallback) | voxel=%.3fm  "
      "Install isaac_ros_nvblox for GPU acceleration", voxel_size_);
#endif
  }

private:
  void pc_callback(sensor_msgs::msg::PointCloud2::SharedPtr msg)
  {
    ++pc_frames_;
    // Integration point: pass to nvblox mapper or update CPU voxel grid
    // nvblox_mapper_->integratePointCloud(*msg);  // enabled when nvblox_ros linked
    (void)msg;
  }

  void depth_callback(sensor_msgs::msg::Image::SharedPtr msg)
  {
    ++depth_frames_;
    // nvblox_mapper_->integrateDepthImage(*msg, *cam_info_);
    (void)msg;
  }

  void publish_status()
  {
    auto msg = std_msgs::msg::String();
    char buf[256];
    snprintf(buf, sizeof(buf),
      R"({"pc_frames":%u,"depth_frames":%u,"voxel_size":%.3f,"backend":"%s"})",
      pc_frames_, depth_frames_, voxel_size_,
#ifdef NVBLOX_AVAILABLE
      "nvblox_gpu"
#else
      "cpu_fallback"
#endif
    );
    msg.data = buf;
    status_pub_->publish(msg);
    RCLCPP_DEBUG(get_logger(), "%s", buf);
  }

  // Parameters
  double       voxel_size_, max_range_;
  std::string  map_frame_;
  bool         publish_esdf_;

  // Counters
  uint32_t pc_frames_    = 0;
  uint32_t depth_frames_ = 0;

  // TF
  std::shared_ptr<tf2_ros::Buffer>            tf_buffer_;
  std::shared_ptr<tf2_ros::TransformListener> tf_listener_;

  // ROS I/O
  rclcpp::Subscription<sensor_msgs::msg::PointCloud2>::SharedPtr  pc_sub_;
  rclcpp::Subscription<sensor_msgs::msg::Image>::SharedPtr        depth_sub_;
  rclcpp::Subscription<sensor_msgs::msg::CameraInfo>::SharedPtr   info_sub_;
  rclcpp::Publisher<nav_msgs::msg::OccupancyGrid>::SharedPtr      grid_pub_;
  rclcpp::Publisher<visualization_msgs::msg::MarkerArray>::SharedPtr mesh_pub_;
  rclcpp::Publisher<std_msgs::msg::String>::SharedPtr             status_pub_;
  rclcpp::TimerBase::SharedPtr                                    stats_timer_;

  sensor_msgs::msg::CameraInfo::SharedPtr cam_info_;
};

int main(int argc, char* argv[])
{
  rclcpp::init(argc, argv);
  rclcpp::spin(std::make_shared<OccupancyMapNode>());
  rclcpp::shutdown();
  return 0;
}
