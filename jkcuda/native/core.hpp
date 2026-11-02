#pragma once
#include <cstdint>

// The production state machine is compiled both by NVCC and by the native test
// adapter. CPU execution is an explicit verification backend, never a fallback
// silently selected for CUDA. All offsets below are physical, rebuildable data.
#ifdef __CUDACC__
#define JK_HD __host__ __device__
#else
#define JK_HD
#endif
namespace jk {
using I = int64_t;
enum Section { QUEUES, NODES, SOURCES, OPS, EDGES, STATES, TASKS, PARAMS,
               EVENTS, TOKENS, TRACES, OUTPUTS, TXOPS, TXPARAMS, BUDGETS, CURRENT, MUTATIONS, FRAMES, NS };
enum Meta { ABI, ACTIVE, STOP, REASON, NTASK, NEVENT, NTOKEN, NOUT, NTRACE,
            NTX, COMPLETE, ECOUNT, DCOUNT, RCOUNT, GCOUNT, EXCOUNT, EXTERNAL,
            RES_TASK, RES_TOKEN, RES_TRACE, FAULT_POINT, FAULT_AFTER,
            FAULT_SEEN, LAST_WORK, LAST_COMPLETE, NENQUEUE, NSELECT, ROOT_VERSION, MODEL_INDEX, NMUTATION };
enum Stop { RUNNABLE=0, RESOURCE=1, FAILED=2, BUDGET=3 };
enum Trace { ENQUEUE=1, SELECT, BIND, COMMIT, EVENT, DELIVERY, MATCH, DONE, OUTPUT, STRUCTURE };
enum Phase { QUEUED=0, SELECTED=1, EVALUATED=2, PROPAGATING=3, FINISHED=4, MISSING=5 };
constexpr I HEADER=128;
#include "frames.hpp"
JK_HD inline bool layout_valid(I* a,I size) {
 if(size<HEADER||a[ABI]!=2)return false;
 I end=HEADER;
 for(I s=0;s<NS;++s){I offset=a[64+s*3],capacity=a[65+s*3],width=a[66+s*3];
  if(offset!=end||capacity<0||width<1||offset>size||capacity>(size-offset)/width)return false;
  end=offset+capacity*width;
 }
 return end==size&&a[66+NODES*3]==17&&a[66+TASKS*3]==16&&a[66+EVENTS*3]==9&&a[66+TRACES*3]==10;
}
struct Arena {
 I* a;
 JK_HD I& m(int k) { return a[k]; }
 JK_HD I cap(int s) const { return a[64+s*3+1]; }
 JK_HD I width(int s) const { return a[64+s*3+2]; }
 JK_HD I* row(int s,I i) const { return a+a[64+s*3]+i*width(s); }
 JK_HD void log_at(I at,I kind,I task=-1,I node=-1,I v=-1,I event=-1,I p=-1,I key=-1,I x=-1,I y=-1,I z=-1) {
  I* r=row(TRACES,at);
  r[0]=kind;r[1]=task;r[2]=node;r[3]=v;r[4]=event;
  r[5]=p;r[6]=key;r[7]=x;r[8]=y;r[9]=z;
 }
 JK_HD void log(I kind,I task=-1,I node=-1,I v=-1,I event=-1,I p=-1,I key=-1,I x=-1,I y=-1,I z=-1) {
  log_at(m(NTRACE)++,kind,task,node,v,event,p,key,x,y,z);
 }
 JK_HD bool room(int section,I used,I need) {
  if(frame::configured(*this)){
   I* b=row(FRAMES,0);
   if(section==TASKS)used+=b[frame::TASK_CREDIT];
   if(section==TRACES)used+=b[frame::TRACE_CREDIT];
   if(section==FRAMES)used+=b[frame::WORD_CREDIT];
  }
  if (need>cap(section)-used) { m(STOP)=RESOURCE;m(REASON)=section;return false; }
  return true;
 }
 JK_HD bool fault(I point) {
  if (m(FAULT_POINT)!=point) return false;
  if (m(FAULT_SEEN)++<m(FAULT_AFTER)) return false;
  m(FAULT_POINT)=0;m(STOP)=FAILED;m(REASON)=point;return true;
 }
 JK_HD bool publishes(I node,I result,I seed) {
  I p=row(NODES,node)[9];
  return p==0 || (p==1&&result==0) || (p==2&&result==1) || (p==4&&result!=seed);
 }
 JK_HD void prepare_task(I t,I node,I key,I queue,I cause,I event,I tx=-1,I txcount=0) {
  I* r=row(TASKS,t);
  for(I j=0;j<width(TASKS);++j)r[j]=-1;
  r[0]=node;r[1]=key;r[2]=queue;r[4]=QUEUED;r[7]=-1;r[8]=0;r[9]=0;
  r[10]=cause;r[11]=event;r[12]=tx;r[13]=txcount;
 }
 JK_HD void link_task(I t,I queue) {
  I* q=row(QUEUES,queue);
  if(q[2]>=0)row(TASKS,q[2])[3]=t; else q[1]=t;
  q[2]=t;q[3]++;
 }
 JK_HD I append(I node,I key,I queue,I cause,I event,I tx=-1,I txcount=0) {
  I t=m(NTASK)++;prepare_task(t,node,key,queue,cause,event,tx,txcount);
  link_task(t,queue);m(NENQUEUE)++;
  return t;
 }
 JK_HD bool budget_available(I t) {
  I* task=row(TASKS,t);
  if(task[0]<-1)return true;
  for(I b=0;b<cap(BUDGETS);++b){
   I required=0;
   if(task[12]<0) required=row(NODES,task[0])[15]==b?1:0;
   else for(I j=0;j<task[13];++j) if(row(NODES,row(TXOPS,task[12]+j)[1])[15]==b)required++;
   I* budget=row(BUDGETS,b);
   if(required && (budget[1]<budget[2] || required>budget[1]-budget[2])) {
    m(STOP)=BUDGET;m(REASON)=budget[0];return false;
   }
  }
  return true;
 }
 JK_HD bool select() {
  I chosen=-1,priority=0;
  for(I q=0;q<cap(QUEUES);++q){I* r=row(QUEUES,q);
   if(r[1]>=0 && (chosen<0 || r[0]<priority)){chosen=q;priority=r[0];}
  }
  if(chosen<0)return false;
  I* queue=row(QUEUES,chosen);I t=queue[1];
  if(!budget_available(t)||!room(TRACES,m(NTRACE),1))return false;
  I* task=row(TASKS,t);queue[1]=task[3];if(queue[1]<0)queue[2]=-1;queue[3]--;
  task[3]=-1;task[4]=SELECTED;m(ACTIVE)=t;m(NSELECT)++;
  log(SELECT,t,task[0]);return true;
 }
 // Transaction state reads see the most recent candidate for the same slot.
 // This is an ordered internal dependency, not execution of another task.
 JK_HD I state_value(I state,I txstart=-1,I before=0) {
  if(txstart>=0) for(I j=before;j>0;--j){I* op=row(TXOPS,txstart+j-1);
   if(op[4] && row(NODES,op[1])[0]==state)return op[3];}
  return row(STATES,state)[0];
 }
 JK_HD bool evaluate_one(I /*task*/,I node,I* params,I txstart,I before,I& seed,I& result) {
  I* n=row(NODES,node);seed=n[0]>=0?state_value(n[0],txstart,before):n[1];result=seed;
  for(I j=0;j<n[5];++j){I* s=row(SOURCES,n[4]+j);if(s[0]!=2)continue;
   I value=params[s[1]];if(value<=-2&&txstart>=0){I ref=-value-2;
    if(ref>=before||!row(TXOPS,txstart+ref)[4])return false;value=row(TXOPS,txstart+ref)[3];}
   if(value!=0&&value!=1)return false;
  }
  // Sources are immutable for this evaluation. No model state is written until
  // the whole task (or declared transaction) is ready to commit.
  for(I j=0;j<n[3];++j){I* op=row(OPS,n[2]+j);I* s=row(SOURCES,op[1]);I v=-1;
   if(s[0]==0 || s[0]==4)v=s[1];
   else if(s[0]==1)v=state_value(s[1],txstart,before);
   else if(s[0]==2){v=params[s[1]];
    if(v<=-2 && txstart>=0){I ref=-v-2;if(ref>=before)return false;v=row(TXOPS,txstart+ref)[3];}
   } else if(s[0]==3)v=seed;
   if(v!=0&&v!=1)return false;
   result=op[0]==0?(result&v):(result^v);
  }
  return true;
 }
 JK_HD bool evaluate(I t) {
  I* task=row(TASKS,t);I count=task[12]<0?1:task[13];
  if(!room(TRACES,m(NTRACE),count))return false;
  if(task[12]<0){I seed,result;bool ok=evaluate_one(t,task[0],row(PARAMS,t),-1,0,seed,result);
   task[5]=seed;task[6]=result;log(BIND,t,task[0],seed);
   task[4]=ok?EVALUATED:MISSING;
  }else{
   bool ok=true;
   for(I j=0;j<count;++j){I* op=row(TXOPS,task[12]+j);I seed,result;
    bool valid=evaluate_one(t,op[1],row(TXPARAMS,task[12]+j),task[12],j,seed,result);
    op[2]=seed;op[3]=result;op[4]=valid?1:0;log(BIND,t,op[1],seed,-1,-1,task[1],j);
    if(!valid){ok=false;break;}
   }
   task[4]=ok?EVALUATED:MISSING;
  }
  return true;
 }
 JK_HD bool commit(I t) {
  I* task=row(TASKS,t);I count=task[12]<0?1:task[13];I events=0,outputs=0,fanout=0;
  for(I j=0;j<count;++j){I node=task[12]<0?task[0]:row(TXOPS,task[12]+j)[1];I state=row(NODES,node)[0];
   if(state<0)continue;I writes=1;
   if(task[12]>=0)for(I k=j+1;k<count;++k)if(row(NODES,row(TXOPS,task[12]+k)[1])[0]==state)writes++;
   if(row(STATES,state)[1]>INT64_MAX-writes){m(STOP)=FAILED;m(REASON)=6;return false;}
  }
  for(I j=0;j<count;++j){I node=task[12]<0?task[0]:row(TXOPS,task[12]+j)[1];
   I result=task[12]<0?task[6]:row(TXOPS,task[12]+j)[3];
   I seed=task[12]<0?task[5]:row(TXOPS,task[12]+j)[2];
   if(publishes(node,result,seed)){events++;I* n=row(NODES,node);
    I current=row(CURRENT,n[16])[0];if(current>=0&&row(NODES,current)[13]!=n[13])current=-1;
    if(current>=0)fanout+=row(NODES,current)[12];if(n[10]>=0)outputs++;}
  }
  // Conservatively reserve every possible successor and unmatched token before
  // any state write. Ingress cannot consume these credits while we yield.
  I extra_tasks=0,extra_traces=0;
  for(I j=0;j<count;++j){I node=task[12]<0?task[0]:row(TXOPS,task[12]+j)[1];
   if(!frame_business_reservation(*this,t,node,extra_tasks,extra_traces))return false;
  }
  I trace_need=count+events+outputs+fanout*3+events+1+extra_traces;
  if(!room(TASKS,m(NTASK),fanout+extra_tasks)||!room(TOKENS,m(NTOKEN),fanout)||
     !room(EVENTS,m(NEVENT),events)||!room(OUTPUTS,m(NOUT),outputs)||
     !room(TRACES,m(NTRACE),trace_need))return false;
  if(fault(1))return false;
  m(RES_TASK)=fanout+extra_tasks;m(RES_TOKEN)=fanout;m(RES_TRACE)=trace_need;
  task[7]=m(NEVENT);task[8]=events;task[9]=0;
  for(I j=0;j<count;++j){I node=task[12]<0?task[0]:row(TXOPS,task[12]+j)[1];I* n=row(NODES,node);
   I result=task[12]<0?task[6]:row(TXOPS,task[12]+j)[3];
   I seed=task[12]<0?task[5]:row(TXOPS,task[12]+j)[2];I version=-1;
   if(n[0]>=0){I* s=row(STATES,n[0]);s[0]=result;version=++s[1];}
   log(COMMIT,t,node,result,-1,-1,task[1],version,j);m(RES_TRACE)--;m(EXCOUNT)++;
   frame_business_commit(*this,t,node);
   if(publishes(node,result,seed)){
    I e=m(NEVENT)++;I* event=row(EVENTS,e);
    I current=row(CURRENT,n[16])[0];if(current>=0&&row(NODES,current)[13]!=n[13])current=-1;
    I* graph=current>=0?row(NODES,current):n;
    event[0]=t;event[1]=node;event[2]=result;event[3]=task[1];event[4]=0;
    event[5]=graph[11];event[6]=current>=0?graph[12]:0;event[7]=0;event[8]=current;
    log(EVENT,t,node,result,e,-1,task[1]);m(RES_TRACE)--;m(GCOUNT)++;
    if(n[10]>=0){I o=m(NOUT)++;I* output=row(OUTPUTS,o);
     output[0]=t;output[1]=node;output[2]=result;output[3]=task[1];output[4]=e;output[5]=n[10];output[6]=0;output[7]=j;
     frame_capture_output(*this,t,node,result,o);
     log(OUTPUT,t,node,result,e,n[10],task[1],o);m(RES_TRACE)--;
    }
   }
  }
  task[4]=PROPAGATING;m(ROOT_VERSION)++;
  if(fault(2))return false;
  return true;
 }
 JK_HD I earliest(I target,I port,I key,bool keyed) {
  for(I i=0;i<m(NTOKEN);++i){I* r=row(TOKENS,i);
   if(r[6]&&r[0]==target&&r[1]==port&&(!keyed||r[3]==key))return i;}
  return -1;
 }
 JK_HD void deliver(I t,I e,I edge) {
  I* ev=row(EVENTS,e);I* ed=row(EDGES,edge);I target=ed[1],port=ed[2];I* n=row(NODES,target);
  I mode=n[6],key=ev[3];
  log(DELIVERY,t,target,ev[2],e,port,key,ev[1],ed[3]);m(RES_TRACE)--;m(DCOUNT)++;
  bool ready=mode==0;
  if(mode!=0){
   I token=mode==1?earliest(target,port,key,false):-1;
   if(token<0){token=m(NTOKEN)++;m(RES_TOKEN)--;}
   I* r=row(TOKENS,token);r[0]=target;r[1]=port;r[2]=ev[2];r[3]=key;r[4]=e;r[5]=edge;r[6]=1;r[7]=t;
   ready=true;for(I p=0;p<n[7];++p)if(earliest(target,p,key,mode==3)<0){ready=false;break;}
  }
  if(ready){
   I newtask=append(target,key,n[8],t,e);m(RES_TASK)--;I* params=row(PARAMS,newtask);
   for(I p=0;p<width(PARAMS);++p)params[p]=-1;
   if(mode==0)params[port]=ev[2];
   else for(I p=0;p<n[7];++p){I index=earliest(target,p,key,mode==3);I* token=row(TOKENS,index);params[p]=token[2];token[6]=0;}
   log(MATCH,newtask,target,-1,e,-1,key);m(RES_TRACE)--;
   log(ENQUEUE,newtask,target,-1,e,-1,key);m(RES_TRACE)--;m(RCOUNT)++;
  }
 }
 JK_HD bool propagate(I t) {
  I* task=row(TASKS,t);
  if(task[9]>=task[8])return finish(t,false);
  I e=task[7]+task[9];I* ev=row(EVENTS,e);
  if(ev[4]<ev[6]){
   if(fault(3))return false;
   deliver(t,e,ev[5]+ev[4]);ev[4]++;
   if(fault(4))return false;
   return true;
  }
  ev[7]=1;task[9]++;m(ECOUNT)++;return true;
 }
 JK_HD bool finish(I t,bool missing) {
  I* task=row(TASKS,t);
  if(!room(TRACES,m(NTRACE),1))return false;
  log(DONE,t,task[0],missing?1:0);
  if(!missing&&task[0]>=-1){
   I count=task[12]<0?1:task[13];for(I j=0;j<count;++j){
    I node=task[12]<0?task[0]:row(TXOPS,task[12]+j)[1];I b=row(NODES,node)[15];
    if(b>=0)row(BUDGETS,b)[2]++;
   }
  }
  task[4]=FINISHED;m(ACTIVE)=-1;m(COMPLETE)++;
  m(RES_TASK)=m(RES_TOKEN)=m(RES_TRACE)=0;return true;
 }
 JK_HD bool modify(I t) {
  I* task=row(TASKS,t);
  if(!room(TRACES,m(NTRACE),2))return false;
  // Check at execution, not just admission: intervening tasks may have left
  // additional unmatched input. Undefined trigger migrations are rejected as
  // a normal, recorded structural result without changing or dropping tokens.
  bool reject=false;
  for(I j=0;j<task[13];++j){I* change=row(MUTATIONS,task[12]+j);
   if(!change[2])continue;
   for(I k=0;k<m(NTOKEN);++k){I* token=row(TOKENS,k);
    if(token[6]&&row(NODES,token[0])[16]==change[0]){reject=true;break;}}
   if(reject)break;
  }
  if(fault(1))return false;
  if(!reject){
   for(I j=0;j<task[13];++j){I* change=row(MUTATIONS,task[12]+j);row(CURRENT,change[0])[0]=change[1];}
   for(I k=0;k<m(NTOKEN);++k){I* token=row(TOKENS,k);if(!token[6])continue;
    I current=row(CURRENT,row(NODES,token[0])[16])[0];if(current>=0)token[0]=current;
   }
   m(MODEL_INDEX)=task[14];m(ROOT_VERSION)++;
  }
  task[6]=reject?0:1;task[4]=PROPAGATING;task[7]=m(NEVENT);task[8]=0;task[9]=0;
  log(STRUCTURE,t,-2,task[14],-1,-1,-1,reject?0:1);
  if(fault(2))return false;
  return true;
 }
 JK_HD bool advance_one() {
   bool progress=false;
   if(m(ACTIVE)<0)progress=select();
   else {I t=m(ACTIVE),phase=row(TASKS,t)[4];
    if(phase==SELECTED){I node=row(TASKS,t)[0];
     progress=node==-2?modify(t):(node==-3?frame_execute(*this,t):evaluate(t));}
    else if(phase==EVALUATED)progress=commit(t);
    else if(phase==PROPAGATING)progress=propagate(t);
    else if(phase==MISSING)progress=finish(t,true);
   }
   return progress;
 }
 JK_HD void advance(I maxwork,I maxtasks) {
  m(LAST_WORK)=m(LAST_COMPLETE)=0;I old=m(COMPLETE);
  for(I work=0;work<maxwork&&m(STOP)==RUNNABLE&&m(COMPLETE)-old<maxtasks;++work){
   if(!advance_one())break;m(LAST_WORK)++;
  }
  m(LAST_COMPLETE)=m(COMPLETE)-old;
 }
};
#include "propagation.hpp"
}
