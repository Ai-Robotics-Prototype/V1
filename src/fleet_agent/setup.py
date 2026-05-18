from setuptools import setup
import os

package_name = 'fleet_agent'

setup(
    name=package_name,
    version='0.1.0',
    packages=[package_name],
    data_files=[
        ('share/ament_index/resource_index/packages', ['resource/' + package_name]),
        ('share/' + package_name, ['package.xml']),
        (os.path.join('share', package_name, 'launch'), ['launch/fleet.launch.py']),
        (os.path.join('share', package_name, 'config'), ['config/fleet.yaml']),
    ],
    install_requires=['setuptools'],
    zip_safe=True,
    maintainer='cobot',
    maintainer_email='robot@cobot',
    description='Experience logging, OTA model updates, and cloud sync',
    license='Apache-2.0',
    entry_points={
        'console_scripts': [
            'experience_logger_node = fleet_agent.experience_logger_node:main',
            'upload_agent_node = fleet_agent.upload_agent_node:main',
            'update_agent_node = fleet_agent.update_agent_node:main',
        ],
    },
)
