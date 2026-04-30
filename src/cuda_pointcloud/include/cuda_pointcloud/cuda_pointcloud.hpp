#pragma once

#include <cuda_runtime.h>
#include <cstdint>
#include <cstddef>

namespace cuda_pc {

// ── Point layout (XYZ + intensity, 16-byte aligned) ─────────────────────────
struct alignas(16) Point4f {
  float x, y, z, intensity;
};

// ── Voxel grid downsampling ─────────────────────────────────────────────────
//  d_in      : input points on device
//  n_in      : number of input points
//  d_out     : output buffer (pre-allocated, size >= n_in)
//  n_out     : number of output points (written by kernel)
//  voxel_size: side length of each voxel in metres
//  Returns cudaError_t
cudaError_t voxel_grid_filter(
  const Point4f* d_in,
  std::size_t    n_in,
  Point4f*       d_out,
  std::size_t*   n_out,
  float          voxel_size,
  cudaStream_t   stream = 0);

// ── Range filter (min/max on Z axis) ─────────────────────────────────────────
cudaError_t range_filter(
  const Point4f* d_in,
  std::size_t    n_in,
  Point4f*       d_out,
  std::size_t*   n_out,
  float          min_range,
  float          max_range,
  cudaStream_t   stream = 0);

// ── Cloud concatenation ───────────────────────────────────────────────────────
//  Merges up to 8 clouds into d_out.  Each cloud i has n_pts[i] points.
cudaError_t concat_clouds(
  const Point4f* const* d_clouds,
  const std::size_t*    n_pts,
  std::size_t           n_clouds,
  Point4f*              d_out,
  std::size_t*          n_out,
  cudaStream_t          stream = 0);

// ── Surface normal estimation (PCA over k-nearest neighbours) ────────────────
struct Normal4f { float nx, ny, nz, curvature; };

cudaError_t estimate_normals(
  const Point4f* d_in,
  std::size_t    n_in,
  Normal4f*      d_normals,
  int            k_neighbours = 20,
  cudaStream_t   stream = 0);

// ── Utility: allocate / free device cloud buffers ────────────────────────────
Point4f* alloc_cloud(std::size_t n_points);
void     free_cloud(Point4f* ptr);

}  // namespace cuda_pc
