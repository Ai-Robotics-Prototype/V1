cmake_minimum_required(VERSION 3.8)
project(cobot_bringup)

find_package(ament_cmake REQUIRED)

install(DIRECTORY launch config urdf scripts
  DESTINATION share/${PROJECT_NAME}
  USE_SOURCE_PERMISSIONS
)

if(BUILD_TESTING)
  find_package(ament_lint_auto REQUIRED)
  ament_lint_auto_find_test_dependencies()
endif()

ament_package()
