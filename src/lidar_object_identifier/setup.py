from setuptools import setup, find_packages
from glob import glob

package_name = 'lidar_object_identifier'

setup(
    name=package_name,
    version='0.1.0',
    packages=find_packages(exclude=['test']),
    data_files=[
        ('share/ament_index/resource_index/packages', ['resource/' + package_name]),
        ('share/' + package_name, ['package.xml']),
        ('share/' + package_name + '/launch', glob('launch/*.py')),
        ('share/' + package_name + '/config', glob('config/*.yaml')),
    ],
    install_requires=['setuptools', 'numpy', 'scipy', 'pyyaml'],
    zip_safe=True,
    maintainer='cobot',
    maintainer_email='robot@cobot.local',
    description='Static LiDAR object identification + parts library matching',
    license='Apache-2.0',
    entry_points={
        'console_scripts': [
            'identifier_node = lidar_object_identifier.identifier_node:main',
        ],
    },
)
