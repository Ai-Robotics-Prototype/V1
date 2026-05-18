from setuptools import setup

package_name = 'human_safety'

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
    description='Human skeleton detection and proximity node',
    license='Apache-2.0',
    entry_points={
        'console_scripts': [
            'human_safety_node = human_safety.human_safety_node:main',
        ],
    },
)
