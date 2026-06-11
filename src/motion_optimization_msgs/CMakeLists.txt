cmake_minimum_required(VERSION 3.8)
project(motion_optimization_msgs)

find_package(ament_cmake REQUIRED)
find_package(rosidl_default_generators REQUIRED)
find_package(std_msgs REQUIRED)
find_package(trajectory_msgs REQUIRED)

set(msg_files
  msg/MotionProfile.msg
  msg/OptimizedTrajectory.msg
  msg/MotionStatistics.msg
)

set(srv_files
  srv/OptimizeTrajectory.srv
  srv/EstimateCycleTime.srv
  srv/ValidateMotion.srv
  srv/SaveProfile.srv
  srv/DeleteProfile.srv
)

rosidl_generate_interfaces(${PROJECT_NAME}
  ${msg_files}
  ${srv_files}
  DEPENDENCIES std_msgs trajectory_msgs
)

ament_export_dependencies(rosidl_default_runtime)
ament_package()
