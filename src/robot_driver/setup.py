from setuptools import setup, find_packages
import os

package_name = 'robot_driver'

setup(
    name=package_name,
    version='0.1.0',
    packages=find_packages(exclude=['test']),
    data_files=[
        ('share/ament_index/resource_index/packages', ['resource/' + package_name]),
        ('share/' + package_name, ['package.xml']),
        (os.path.join('share', package_name, 'config'),  ['config/robot_driver.yaml']),
        (os.path.join('share', package_name, 'launch'),  ['launch/robot_driver.launch.py']),
    ],
    install_requires=['setuptools'],
    zip_safe=True,
    maintainer='cobot',
    maintainer_email='robot@cobot',
    description='Generic TCP/IP robot driver',
    license='Apache-2.0',
    entry_points={
        'console_scripts': [
            'robot_driver_node = robot_driver.robot_driver_node:main',
        ],
    },
)
