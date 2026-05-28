from setuptools import setup

package_name = 'object_detection'

setup(
    name=package_name,
    version='0.1.0',
    packages=[package_name],
    data_files=[
        ('share/ament_index/resource_index/packages', ['resource/' + package_name]),
        ('share/' + package_name, ['package.xml']),
    ],
    install_requires=['setuptools'],
    zip_safe=True,
    maintainer='cobot',
    maintainer_email='robot@cobot',
    description='YOLOv8 3D object detection node',
    license='Apache-2.0',
    entry_points={
        'console_scripts': [
            'detector_node = object_detection.detector_node:main',
            'depth_detector_node = object_detection.depth_detector_node:main',
            'depth_segment_node = object_detection.depth_segment_node:main',
            'lidar_detector_node = object_detection.lidar_detector_node:main',
            'stereo_verifier_node = object_detection.stereo_verifier_node:main',
            'grasp_planner = object_detection.grasp_planner:main',
        ],
    },
)
