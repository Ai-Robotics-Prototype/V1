from setuptools import setup

package_name = 'language_interface'

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
    description='Ollama LLM natural language command interface',
    license='Apache-2.0',
    entry_points={
        'console_scripts': [
            'language_node = language_interface.language_node:main',
        ],
    },
)
