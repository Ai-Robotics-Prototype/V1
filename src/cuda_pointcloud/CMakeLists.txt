cmake_minimum_required(VERSION 3.18)
project(cuda_pointcloud CUDA CXX)

# ── CUDA settings ──────────────────────────────────────────────────────────────
set(CMAKE_CUDA_STANDARD 17)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CUDA_ARCHITECTURES 87)   # Jetson AGX Orin SM87

if(CMAKE_COMPILER_IS_GNUCXX OR CMAKE_CXX_COMPILER_ID MATCHES "Clang")
  add_compile_options(-Wall -Wextra -Wpedantic)
endif()

find_package(ament_cmake REQUIRED)
find_package(rclcpp REQUIRED)
find_package(sensor_msgs REQUIRED)
find_package(geometry_msgs REQUIRED)
find_package(tf2_ros REQUIRED)
find_package(tf2_sensor_msgs REQUIRED)
find_package(CUDAToolkit REQUIRED)

# ── CUDA kernel library ────────────────────────────────────────────────────────
add_library(cuda_kernels STATIC
  src/voxel_grid.cu
  src/range_filter.cu
  src/cloud_concat.cu
  src/normal_estimation.cu
)
target_include_directories(cuda_kernels PUBLIC
  $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>
  $<INSTALL_INTERFACE:include>
)
target_link_libraries(cuda_kernels CUDA::cudart CUDA::cufft)
set_target_properties(cuda_kernels PROPERTIES
  CUDA_SEPARABLE_COMPILATION ON
  POSITION_INDEPENDENT_CODE ON
)

# ── ROS2 node ─────────────────────────────────────────────────────────────────
add_executable(cuda_pointcloud_node src/cuda_pointcloud_node.cpp)
target_include_directories(cuda_pointcloud_node PRIVATE
  ${CMAKE_CURRENT_SOURCE_DIR}/include
)
target_link_libraries(cuda_pointcloud_node cuda_kernels CUDA::cudart)
ament_target_dependencies(cuda_pointcloud_node
  rclcpp sensor_msgs geometry_msgs tf2_ros tf2_sensor_msgs)

install(TARGETS cuda_pointcloud_node cuda_kernels
  ARCHIVE DESTINATION lib
  LIBRARY DESTINATION lib
  RUNTIME DESTINATION lib/${PROJECT_NAME}
)
install(DIRECTORY include/ DESTINATION include)
install(DIRECTORY launch config DESTINATION share/${PROJECT_NAME})

if(BUILD_TESTING)
  find_package(ament_lint_auto REQUIRED)
  ament_lint_auto_find_test_dependencies()
endif()

ament_package()
