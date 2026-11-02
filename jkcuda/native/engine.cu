#include <torch/extension.h>
#include <c10/cuda/CUDAGuard.h>
#include <c10/cuda/CUDAException.h>
#include <ATen/cuda/CUDAContext.h>
#include "core.hpp"

// The scalar path remains an explicit differential/benchmark baseline.
__global__ void advance_serial_kernel(int64_t* arena,int64_t size,int64_t work,int64_t tasks,
                                      int64_t* scratch,int64_t scratch_size,int64_t chunk) {
 if(blockIdx.x==0&&threadIdx.x==0){
  for(int i=0;i<jk::parallel::HEADER_WORDS;++i)scratch[i]=0;
  if(!jk::layout_valid(arena,size)){arena[jk::STOP]=jk::FAILED;arena[jk::REASON]=100;return;}
  jk::Arena a{arena};
  if(!jk::parallel::workspace_valid(scratch_size,chunk,a.width(jk::PARAMS))){a.m(STOP)=jk::FAILED;a.m(REASON)=100;return;}
  a.advance(work,tasks);
 }
}

// One block cooperates on the same active logical task. Distinct target owners
// match in parallel, while each target's edges remain serial and ordered. A
// barrier joins every producer before FIFO publication/cursor advancement, and
// another barrier precedes the coordinator's next task-selection decision.
// No inter-block fairness assumption or unsupported grid barrier is required.
__global__ void advance_parallel_kernel(int64_t* arena,int64_t size,int64_t work,int64_t tasks,
                                        int64_t* scratch,int64_t scratch_size,int64_t chunk) {
 using namespace jk;
 Arena a{arena};parallel::Workspace w{scratch,a.width(PARAMS)};
 if(threadIdx.x==0){
  parallel::reset(w);w.h(parallel::ACTION)=0;
  if(!layout_valid(arena,size)||!parallel::workspace_valid(scratch_size,chunk,w.params)){a.m(STOP)=FAILED;a.m(REASON)=100;}
  else {a.m(LAST_WORK)=a.m(LAST_COMPLETE)=0;w.h(parallel::OLD_COMPLETE)=a.m(COMPLETE);}
 }
 __syncthreads();
 while(true){
  if(threadIdx.x==0){
   w.h(parallel::ACTION)=0;
   if(a.m(STOP)==RUNNABLE&&a.m(LAST_WORK)<work&&a.m(COMPLETE)-w.h(parallel::OLD_COMPLETE)<tasks){
    if(parallel::available(a)){
     if(parallel::begin(a,w,chunk,work-a.m(LAST_WORK))>0)w.h(parallel::ACTION)=2;
    }else if(a.advance_one()){a.m(LAST_WORK)++;w.h(parallel::ACTION)=1;}
   }
  }
  __syncthreads();
  I action=w.h(parallel::ACTION);if(action==0)break;
  if(action==2){
   I count=w.h(parallel::COUNT);
   for(I i=threadIdx.x;i<count;i+=blockDim.x)parallel::prepare(a,w,i);
   __syncthreads();
   for(I i=threadIdx.x;i<count;i+=blockDim.x)parallel::match_owner(a,w,i);
   __syncthreads();
   for(I i=threadIdx.x;i<count;i+=blockDim.x)parallel::scan_initialize(w,i);
   __syncthreads();
   for(I stride=1;stride<count;stride*=2){
    for(I i=threadIdx.x;i<count;i+=blockDim.x)parallel::scan_prepare(w,i,stride);
    __syncthreads();
    for(I i=threadIdx.x;i<count;i+=blockDim.x)parallel::scan_publish(w,i);
    __syncthreads();
   }
   for(I i=threadIdx.x;i<count;i+=blockDim.x)parallel::scatter(a,w,i);
   __syncthreads();
   if(threadIdx.x==0)parallel::publish(a,w);
  }
  __syncthreads();
 }
 if(threadIdx.x==0)a.m(LAST_COMPLETE)=a.m(COMPLETE)-w.h(parallel::OLD_COMPLETE);
}

void jk_advance_cuda(torch::Tensor arena,int64_t work,int64_t tasks,torch::Tensor scratch,
                     int64_t chunk,int64_t block_size,bool parallel_mode) {
 TORCH_CHECK(arena.is_cuda(),"CUDA arena required");
 TORCH_CHECK(arena.scalar_type()==torch::kInt64&&arena.is_contiguous()&&arena.dim()==1,"contiguous int64 arena required");
 TORCH_CHECK(scratch.is_cuda()&&scratch.device()==arena.device()&&scratch.scalar_type()==torch::kInt64&&scratch.is_contiguous()&&scratch.dim()==1,
             "contiguous int64 scratch on the arena device required");
 TORCH_CHECK(work>0&&tasks>0,"positive execution bounds required");
 TORCH_CHECK(arena.numel()>=jk::HEADER,"arena header is missing");
 TORCH_CHECK(jk::parallel::configuration_valid(chunk,block_size),"invalid propagation chunk/block configuration");
 // Python supplies the exact model-dependent workspace size. Its fixed minimum
 // is checked here without a device-to-host metadata read; the kernel performs
 // the full model-width check before accessing any scratch row.
 TORCH_CHECK(scratch.numel()>=jk::parallel::HEADER_WORDS+chunk*jk::parallel::ROW_FIXED,"scratch header/rows are missing");
 auto arena_begin=reinterpret_cast<uintptr_t>(arena.data_ptr<int64_t>());
 auto scratch_begin=reinterpret_cast<uintptr_t>(scratch.data_ptr<int64_t>());
 TORCH_CHECK(arena_begin+arena.numel()*sizeof(int64_t)<=scratch_begin||scratch_begin+scratch.numel()*sizeof(int64_t)<=arena_begin,
             "arena and scratch storage must not overlap");
 c10::cuda::CUDAGuard guard(arena.device());
 int max_threads=0;C10_CUDA_CHECK(cudaDeviceGetAttribute(&max_threads,cudaDevAttrMaxThreadsPerBlock,arena.get_device()));
 TORCH_CHECK(block_size<=max_threads,"block size exceeds device limit");
 auto stream=at::cuda::getCurrentCUDAStream(arena.get_device());
 if(parallel_mode)advance_parallel_kernel<<<1,block_size,0,stream>>>(arena.data_ptr<int64_t>(),arena.numel(),work,tasks,scratch.data_ptr<int64_t>(),scratch.numel(),chunk);
 else advance_serial_kernel<<<1,1,0,stream>>>(arena.data_ptr<int64_t>(),arena.numel(),work,tasks,scratch.data_ptr<int64_t>(),scratch.numel(),chunk);
 C10_CUDA_KERNEL_LAUNCH_CHECK();
}
