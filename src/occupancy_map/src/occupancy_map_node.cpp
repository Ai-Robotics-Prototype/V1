#include <rclcpp/rclcpp.hpp>
#include <sensor_msgs/msg/point_cloud2.hpp>
#include <nav_msgs/msg/occupancy_grid.hpp>

class OccupancyMapNode : public rclcpp::Node
{
public:
  OccupancyMapNode() : Node("occupancy_map_node")
  {
    sub_ = create_subscription<sensor_msgs::msg::PointCloud2>(
      "/perception/fused_cloud", 10,
      [this](sensor_msgs::msg::PointCloud2::SharedPtr msg) {
        (void)msg;
        RCLCPP_DEBUG(get_logger(), "Received fused cloud");
      });
    pub_ = create_publisher<nav_msgs::msg::OccupancyGrid>("/map/occupancy", 10);
    RCLCPP_INFO(get_logger(), "occupancy_map_node started (nvblox stub)");
  }

private:
  rclcpp::Subscription<sensor_msgs::msg::PointCloud2>::SharedPtr sub_;
  rclcpp::Publisher<nav_msgs::msg::OccupancyGrid>::SharedPtr pub_;
};

int main(int argc, char * argv[])
{
  rclcpp::init(argc, argv);
  rclcpp::spin(std::make_shared<OccupancyMapNode>());
  rclcpp::shutdown();
  return 0;
}
