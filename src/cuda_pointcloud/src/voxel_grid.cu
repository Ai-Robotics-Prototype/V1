#include "cuda_pointcloud/cuda_pointcloud.hpp"

#include <thrust/device_vector.h>
#include <thrust/sort.h>
#include <thrust/unique.h>
#include <thrust/execution_policy.h>

#include <cuda_runtime.h>
#include <cmath>

namespace cuda_pc {

// ── Helpers ───────────────────────────────────────────────────────────────────

__device__ inline int64_t voxel_key(float x, float y, float z, float inv_vs)
{
  // Morton-style hash; big enough for a 5 m cube at 2.5 cm = 200 voxels/axis
  auto ix = static_cast<int32_t>(floorf(x * inv_vs));
  auto iy = static_cast<int32_t>(floorf(y * inv_vs));
  auto iz = static_cast<int32_t>(floorf(z * inv_vs));
  // Pack into int64 with 20-bit fields each (±512 k voxels / axis)
  constexpr int64_t OFFSET = (1 << 19);
  return ((int64_t)(ix + OFFSET) & 0xFFFFF)
       | (((int64_t)(iy + OFFSET) & 0xFFFFF) << 20)
       | (((int64_t)(iz + OFFSET) & 0xFFFFF) << 40);
}

// ── Step 1: compute voxel key per point ──────────────────────────────────────
__global__ void k_compute_keys(
  const Point4f* __restrict__ pts,
  int64_t*       __restrict__ keys,
  int32_t*       __restrict__ idx,
  std::size_t n,
  float inv_vs)
{
  const auto i = blockIdx.x * blockDim.x + threadIdx.x;
  if (i >= n) return;
  keys[i] = voxel_key(pts[i].x, pts[i].y, pts[i].z, inv_vs);
  idx[i]  = static_cast<int32_t>(i);
}

// ── Step 2: centroid of each voxel (one thread per voxel boundary) ───────────
__global__ void k_centroid(
  const Point4f* __restrict__ pts,
  const int64_t* __restrict__ keys,
  const int32_t* __restrict__ sorted_idx,
  Point4f*       __restrict__ out,
  std::size_t*   __restrict__ n_out_ptr,
  std::size_t    n)
{
  const auto i = blockIdx.x * blockDim.x + threadIdx.x;
  if (i >= n) return;
  // Only the first point of each new voxel key writes a centroid
  if (i > 0 && keys[i] == keys[i - 1]) return;

  // Find run length
  std::size_t run = 1;
  while (i + run < n && keys[i + run] == keys[i]) ++run;

  float ax = 0, ay = 0, az = 0, aw = 0;
  for (std::size_t j = 0; j < run; ++j) {
    const auto& p = pts[sorted_idx[i + j]];
    ax += p.x; ay += p.y; az += p.z; aw += p.intensity;
  }
  const float inv = 1.0f / static_cast<float>(run);
  const auto slot = atomicAdd(reinterpret_cast<unsigned long long*>(n_out_ptr), 1ULL);
  out[slot] = {ax * inv, ay * inv, az * inv, aw * inv};
}

// ── Public API ────────────────────────────────────────────────────────────────
cudaError_t voxel_grid_filter(
  const Point4f* d_in,
  std::size_t    n_in,
  Point4f*       d_out,
  std::size_t*   n_out,
  float          voxel_size,
  cudaStream_t   stream)
{
  if (n_in == 0) { *n_out = 0; return cudaSuccess; }

  const float inv_vs = 1.0f / voxel_size;
  const int block = 256;

  // Allocate key + index arrays
  int64_t* d_keys  = nullptr;
  int32_t* d_idx   = nullptr;
  std::size_t* d_cnt = nullptr;
  cudaMallocAsync(&d_keys, n_in * sizeof(int64_t), stream);
  cudaMallocAsync(&d_idx,  n_in * sizeof(int32_t), stream);
  cudaMallocAsync(&d_cnt,  sizeof(std::size_t),    stream);
  cudaMemsetAsync(d_cnt, 0, sizeof(std::size_t), stream);

  // 1. Compute keys
  k_compute_keys<<<(n_in + block - 1) / block, block, 0, stream>>>(
    d_in, d_keys, d_idx, n_in, inv_vs);

  // 2. Sort by key (bring d_keys and d_idx in lockstep)
  thrust::sort_by_key(thrust::cuda::par.on(stream),
    d_keys, d_keys + n_in, d_idx);

  // 3. Write one centroid per unique key
  k_centroid<<<(n_in + block - 1) / block, block, 0, stream>>>(
    d_in, d_keys, d_idx, d_out, d_cnt, n_in);

  // Copy count back
  cudaMemcpyAsync(n_out, d_cnt, sizeof(std::size_t), cudaMemcpyDeviceToHost, stream);
  cudaStreamSynchronize(stream);

  cudaFreeAsync(d_keys, stream);
  cudaFreeAsync(d_idx,  stream);
  cudaFreeAsync(d_cnt,  stream);

  return cudaGetLastError();
}

}  // namespace cuda_pc
