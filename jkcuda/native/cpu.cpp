#include "core.hpp"
extern "C" int jk_advance(int64_t* arena,int64_t size,int64_t work,int64_t tasks,
                          int64_t* scratch,int64_t scratch_size,int64_t chunk,
                          int64_t block_size,int64_t parallel_mode) {
 if(!jk::layout_valid(arena,size))return 1;
 jk::Arena a{arena};
 if(!scratch||work<1||tasks<1||!jk::parallel::configuration_valid(chunk,block_size)||
    !jk::parallel::workspace_valid(scratch_size,chunk,a.width(jk::PARAMS))||
    (parallel_mode!=0&&parallel_mode!=1))return 1;
 jk::parallel::Workspace workspace{scratch,a.width(jk::PARAMS)};
 if(parallel_mode)jk::parallel::emulate(a,workspace,work,tasks,chunk);
 else {jk::parallel::reset(workspace);a.advance(work,tasks);}
 return 0;
}
