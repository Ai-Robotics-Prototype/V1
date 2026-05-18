#include "cuda_pointcloud/cuda_pointcloud.hpp"
#include <cuda_runtime.h>
#include <float.h>
#include <math.h>

namespace cuda_pc {

// ── Brute-force k-NN + PCA normal estimation ──────────────────────────────────
// Each thread handles one query point.
// For production, replace with cuSpatial k-d tree or FAISS GPU index.

__global__ void k_estimate_normals(
  const Point4f* __restrict__ pts,
  Normal4f*      __restrict__ normals,
  std::size_t    n,
  int            k)
{
  const int qi = blockIdx.x * blockDim.x + threadIdx.x;
  if (qi >= (int)n) return;

  const float qx = pts[qi].x, qy = pts[qi].y, qz = pts[qi].z;

  // ── Find k nearest neighbours (brute force, O(n*k)) ──────────────────────
  // Stack-allocate neighbour distance buffer (k ≤ 32 assumed)
  const int KMAX = 32;
  float  best_d2[KMAX];
  int    best_i [KMAX];
  int    found = 0;

  for (int j = 0; j < (int)n; ++j) {
    if (j == qi) continue;
    float dx = pts[j].x - qx, dy = pts[j].y - qy, dz = pts[j].z - qz;
    float d2 = dx*dx + dy*dy + dz*dz;
    if (found < k) {
      best_d2[found] = d2;
      best_i [found] = j;
      ++found;
      // insertion sort on last element
      for (int m = found-1; m > 0 && best_d2[m] < best_d2[m-1]; --m) {
        float td = best_d2[m]; best_d2[m] = best_d2[m-1]; best_d2[m-1] = td;
        int   ti = best_i [m]; best_i [m] = best_i [m-1]; best_i [m-1] = ti;
      }
    } else if (d2 < best_d2[k-1]) {
      best_d2[k-1] = d2;
      best_i [k-1] = j;
      for (int m = k-1; m > 0 && best_d2[m] < best_d2[m-1]; --m) {
        float td = best_d2[m]; best_d2[m] = best_d2[m-1]; best_d2[m-1] = td;
        int   ti = best_i [m]; best_i [m] = best_i [m-1]; best_i [m-1] = ti;
      }
    }
  }

  // ── Compute covariance matrix of neighbourhood ────────────────────────────
  float cx = 0, cy = 0, cz = 0;
  for (int m = 0; m < found; ++m) {
    cx += pts[best_i[m]].x;
    cy += pts[best_i[m]].y;
    cz += pts[best_i[m]].z;
  }
  cx /= found; cy /= found; cz /= found;

  float c00=0,c01=0,c02=0,c11=0,c12=0,c22=0;
  for (int m = 0; m < found; ++m) {
    float ax = pts[best_i[m]].x - cx;
    float ay = pts[best_i[m]].y - cy;
    float az = pts[best_i[m]].z - cz;
    c00 += ax*ax; c01 += ax*ay; c02 += ax*az;
                  c11 += ay*ay; c12 += ay*az;
                                c22 += az*az;
  }

  // ── Power iteration for smallest eigenvector (normal) ────────────────────
  // One iteration of inverse power method approximation
  float nx = c11*c22 - c12*c12;
  float ny = c02*c12 - c01*c22;
  float nz = c01*c12 - c02*c11;
  float len = sqrtf(nx*nx + ny*ny + nz*nz);
  if (len < 1e-7f) { nx=0; ny=0; nz=1; len=1; }
  nx /= len; ny /= len; nz /= len;

  // Curvature: ratio of smallest eigenvalue approximation
  float trace = c00 + c11 + c22;
  float curv = (trace > 1e-7f) ? fabsf(nx*c00*nx + ny*c11*ny + nz*c22*nz) / trace : 0.0f;

  normals[qi] = {nx, ny, nz, curv};
}

cudaError_t estimate_normals(
  const Point4f* d_in,
  std::size_t    n_in,
  Normal4f*      d_normals,
  int            k_neighbours,
  cudaStream_t   stream)
{
  if (n_in == 0) return cudaSuccess;
  // Cap k to KMAX
  if (k_neighbours > 32) k_neighbours = 32;

  const int block = 128;
  const int grid  = static_cast<int>((n_in + block - 1) / block);
  k_estimate_normals<<<grid, block, 0, stream>>>(d_in, d_normals, n_in, k_neighbours);
  return cudaGetLastError();
}

}  // namespace cuda_pc
