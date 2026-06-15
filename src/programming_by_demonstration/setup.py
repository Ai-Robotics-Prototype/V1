from setuptools import setup, find_packages
import os
from glob import glob

package_name = 'programming_by_demonstration'

setup(
    name=package_name,
    version='0.1.0',
    packages=find_packages(exclude=['test']),
    data_files=[
        ('share/ament_index/resource_index/packages', ['resource/' + package_name]),
        ('share/' + package_name, ['package.xml']),
        (os.path.join('share', package_name, 'launch'),
         glob('launch/*.py')),
        (os.path.join('share', package_name, 'config'),
         glob('config/*.yaml')),
        (os.path.join('share', package_name, 'srv'),
         glob('srv/*.srv')),
    ],
    install_requires=['setuptools'],
    zip_safe=True,
    maintainer='cobot',
    maintainer_email='robot@cobot',
    description='Video+voice demonstrations -> draft RoboAi programs',
    license='Apache-2.0',
    entry_points={
        'console_scripts': [
            'pbd_node = programming_by_demonstration.pbd_node:main',
        ],
    },
)
