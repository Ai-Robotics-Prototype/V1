from setuptools import setup, find_packages
from glob import glob

package_name = 'motion_optimization'

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
    description='Motion path optimization (TOPP-RA + MoveIt2 bridge) for RoboAi cobot stack',
    license='Apache-2.0',
    entry_points={
        'console_scripts': [
            'motion_optimizer_node = motion_optimization.motion_optimizer_node:main',
        ],
    },
)
