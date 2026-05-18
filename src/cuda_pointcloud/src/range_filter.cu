#include "cuda_pointcloud/cuda_pointcloud.hpp"

#include <thrust/copy.h>
#include <thrust/device_ptr.h>
#include <thrust/execution_policy.h>
#include <cuda_runtime.h>

namespace cuda_pc {

struct InRangePredicate {
  float min_z, max_z;
  __device__ bool operator()(const Point4f& p) const {
    const float r = sqrtf(p.x * p.x + p.y * p.y + p.z * p.z);
    return r >= min_z && r <= max_z;
  }
};

cudaError_t range_filter(
  const Point4f* d_in,
  std::size_t    n_in,
  Point4f*       d_out,
  std::size_t*   n_out,
  float          min_range,
  float          max_range,
  cudaStream_t   stream)
{
  if (n_in == 0) { *n_out = 0; return cudaSuccess; }

  InRangePredicate pred{min_range, max_range};

  auto d_in_ptr  = thrust::device_pointer_cast(const_cast<Point4f*>(d_in));
  auto d_out_ptr = thrust::device_pointer_cast(d_out);

  auto end = thrust::copy_if(
    thrust::cuda::par.on(stream),
    d_in_ptr, d_in_ptr + n_in,
    d_out_ptr,
    pred);

  *n_out = static_cast<std::size_t>(end - d_out_ptr);
  return cudaGetLastError();
}

}  // namespace cuda_pc
