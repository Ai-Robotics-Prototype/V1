from setuptools import setup, find_packages
import os

package_name = 'gripper_driver'

setup(
    name=package_name,
    version='0.1.0',
    packages=find_packages(exclude=['test']),
    data_files=[
        ('share/ament_index/resource_index/packages', ['resource/' + package_name]),
        ('share/' + package_name, ['package.xml']),
        (os.path.join('share', package_name, 'config'), ['config/gripper.yaml']),
    ],
    install_requires=['setuptools'],
    zip_safe=True,
    maintainer='cobot',
    maintainer_email='robot@cobot',
    description='Generic TCP/IP gripper driver',
    license='Apache-2.0',
    entry_points={
        'console_scripts': [
            'gripper_node = gripper_driver.gripper_node:main',
        ],
    },
)
