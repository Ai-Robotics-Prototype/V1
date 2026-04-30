cmake_minimum_required(VERSION 3.8)
project(occupancy_map)

set(CMAKE_CXX_STANDARD 17)

if(CMAKE_COMPILER_IS_GNUCXX OR CMAKE_CXX_COMPILER_ID MATCHES "Clang")
  add_compile_options(-Wall -Wextra -Wpedantic)
endif()

find_package(ament_cmake REQUIRED)
find_package(rclcpp REQUIRED)
find_package(sensor_msgs REQUIRED)
find_package(nav_msgs REQUIRED)
find_package(std_msgs REQUIRED)
find_package(geometry_msgs REQUIRED)
find_package(tf2_ros REQUIRED)
find_package(visualization_msgs REQUIRED)

# ── Try to find Isaac ROS nvblox ───────────────────────────────────────────────
find_package(nvblox_ros QUIET)

if(nvblox_ros_FOUND)
  message(STATUS "occupancy_map: nvblox_ros found — building with full nvblox integration")
  add_definitions(-DNVBLOX_AVAILABLE)
else()
  message(STATUS "occupancy_map: nvblox_ros NOT found — building standalone wrapper")
endif()

# ── Main wrapper node ──────────────────────────────────────────────────────────
add_executable(occupancy_map_node src/occupancy_map_node.cpp)

ament_target_dependencies(occupancy_map_node
  rclcpp sensor_msgs nav_msgs std_msgs geometry_msgs tf2_ros visualization_msgs)

if(nvblox_ros_FOUND)
  ament_target_dependencies(occupancy_map_node nvblox_ros)
endif()

install(TARGETS occupancy_map_node DESTINATION lib/${PROJECT_NAME})
install(DIRECTORY launch config DESTINATION share/${PROJECT_NAME})

if(BUILD_TESTING)
  find_package(ament_lint_auto REQUIRED)
  ament_lint_auto_find_test_dependencies()
endif()

ament_package()
