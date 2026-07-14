import os
from glob import glob
from setuptools import setup, find_packages

package_name = 'estun_driver'

setup(
    name=package_name,
    version='0.1.0',
    packages=find_packages(exclude=['test']),
    data_files=[
        ('share/ament_index/resource_index/packages', ['resource/' + package_name]),
        ('share/' + package_name, ['package.xml']),
        (os.path.join('share', package_name, 'config'), glob('config/*.yaml')),
        (os.path.join('share', package_name, 'launch'), glob('launch/*.launch.py')),
    ],
    install_requires=['setuptools', 'websockets'],
    zip_safe=True,
    maintainer='cobot',
    maintainer_email='robot@cobot.local',
    description='ROS2 driver for Estun Codroid S-Series robots',
    license='Apache-2.0',
    entry_points={
        'console_scripts': [
            'estun_driver_node = estun_driver.estun_driver_node:main',
            'program_executor_node = estun_driver.program_executor_node:main',
        ],
    },
)
