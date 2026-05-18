#!/bin/bash
echo "Testing language interface..."
ros2 topic pub --once /language/text_command std_msgs/String \
  "data: 'pick up the bottle on the left'"
sleep 3
ros2 topic echo /task/command --once
ros2 topic echo /language/response --once
