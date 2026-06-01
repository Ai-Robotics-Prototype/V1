from setuptools import setup

package_name = 'task_planner'

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
    description='Pick-and-place state machine task planner',
    license='Apache-2.0',
    entry_points={
        'console_scripts': [
            'task_planner_node = task_planner.task_planner_node:main',
            'auto_program_node = task_planner.auto_program_node:main',
        ],
    },
)
