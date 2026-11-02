#include <torch/extension.h>
void jk_advance_cuda(torch::Tensor arena,int64_t work,int64_t tasks,torch::Tensor scratch,
                     int64_t chunk,int64_t block_size,bool parallel_mode);
PYBIND11_MODULE(TORCH_EXTENSION_NAME,m) { m.def("advance",&jk_advance_cuda); }
