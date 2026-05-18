#include "cuda_pointcloud/cuda_pointcloud.hpp"
#include <cuda_runtime.h>

namespace cuda_pc {

cudaError_t concat_clouds(
  const Point4f* const* d_clouds,
  const std::size_t*    n_pts,
  std::size_t           n_clouds,
  Point4f*              d_out,
  std::size_t*          n_out,
  cudaStream_t          stream)
{
  std::size_t offset = 0;
  for (std::size_t i = 0; i < n_clouds; ++i) {
    if (n_pts[i] == 0 || d_clouds[i] == nullptr) continue;
    cudaError_t err = cudaMemcpyAsync(
      d_out + offset,
      d_clouds[i],
      n_pts[i] * sizeof(Point4f),
      cudaMemcpyDeviceToDevice,
      stream);
    if (err != cudaSuccess) return err;
    offset += n_pts[i];
  }
  *n_out = offset;
  return cudaSuccess;
}

Point4f* alloc_cloud(std::size_t n_points)
{
  Point4f* ptr = nullptr;
  cudaMalloc(&ptr, n_points * sizeof(Point4f));
  return ptr;
}

void free_cloud(Point4f* ptr)
{
  if (ptr) cudaFree(ptr);
}

}  // namespace cuda_pc
