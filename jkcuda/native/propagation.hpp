#pragma once

// Included after Arena inside namespace jk. This scratch space is deliberately
// outside the logical arena: a successful bounded call publishes every prepared
// chunk before it returns. A fatal CUDA error requires a trusted checkpoint,
// never reconstruction from a half-written device scratch area.
namespace parallel {
constexpr I HEADER_WORDS=32, ROW_FIXED=20, MAX_CHUNK=1024;
enum Scratch { BATCHES=0, EDGES_DONE, GROUPS_DONE, TASKS_FORMED, MAX_BATCH,
               OWNER=8, EVENT_ID, COUNT, EDGE_BEGIN, OLD_TOKENS, TASK_BEGIN,
               TRACE_BEGIN, NEW_TOKENS, NEW_TASKS, FAILURE, OLD_COMPLETE,
               ACTION };
enum Entry { TARGET=0, PORT, EDGE_ID, LEADER, ALLOCATED, READY,
             TOKEN_SCAN, TASK_SCAN, TRACE_POSITION, TASK_ID,
             TOKEN_TEMP, TASK_TEMP, TOKEN_DATA=12, PARAM_DATA=20 };
struct Workspace {
 I* p;I params;
 JK_HD I& h(I i){return p[i];}
 JK_HD I* row(I i){return p+HEADER_WORDS+i*(ROW_FIXED+params);}
};
JK_HD inline I words(I chunk,I params){return HEADER_WORDS+chunk*(ROW_FIXED+params);}
JK_HD inline bool workspace_valid(I size,I chunk,I params){
 return chunk>0&&params>=1&&params<=INT64_MAX-ROW_FIXED&&size>=HEADER_WORDS&&
        (size-HEADER_WORDS)/chunk>=ROW_FIXED+params;
}
JK_HD inline bool configuration_valid(I chunk,I block_size){
 return chunk>=1&&chunk<=MAX_CHUNK&&block_size>=32&&block_size<=1024&&block_size%32==0;
}
JK_HD inline void reset(Workspace w){for(I i=0;i<HEADER_WORDS;++i)w.h(i)=0;}
JK_HD inline bool available(Arena a){
 I active=a.m(ACTIVE);if(active<0)return false;
 I* task=a.row(TASKS,active);
 if(task[4]!=PROPAGATING||task[9]>=task[8])return false;
 I* event=a.row(EVENTS,task[7]+task[9]);return event[4]<event[6];
}

// Select an exact logical prefix. Injected before/after-delivery failures have
// the same identity, cursor and fault counter as the serial interpreter. The
// final failing delivery is included only for an after-delivery failure.
JK_HD inline I begin(Arena a,Workspace w,I chunk,I remaining_work){
 I task=a.m(ACTIVE);I* t=a.row(TASKS,task);I e=t[7]+t[9];I* event=a.row(EVENTS,e);
 I count=event[6]-event[4];if(count>chunk)count=chunk;if(count>remaining_work)count=remaining_work;
 w.h(OWNER)=task;w.h(EVENT_ID)=e;w.h(EDGE_BEGIN)=event[5]+event[4];
 w.h(OLD_TOKENS)=a.m(NTOKEN);w.h(TASK_BEGIN)=a.m(NTASK);w.h(TRACE_BEGIN)=a.m(NTRACE);
 w.h(FAILURE)=0;
 I point=a.m(FAULT_POINT);
 if(point==3||point==4){
  I before=a.m(FAULT_AFTER)-a.m(FAULT_SEEN);if(before<0)before=0;
  if(count>before){
   count=point==3?before:before+1;w.h(FAILURE)=point;
   a.m(FAULT_SEEN)+=before+1;
  }else a.m(FAULT_SEEN)+=count;
 }
 w.h(COUNT)=count;
 if(count==0&&w.h(FAILURE)){
  a.m(FAULT_POINT)=0;a.m(STOP)=FAILED;a.m(REASON)=w.h(FAILURE);
 }
 return count;
}

// The event owns a frozen CSR range. Every lane reads only real subscriptions.
// Target ownership depends on logical edge order, never on a scheduling race.
JK_HD inline void prepare(Arena a,Workspace w,I i){
 I* entry=w.row(i);I edge=w.h(EDGE_BEGIN)+i;I* ed=a.row(EDGES,edge);
 entry[TARGET]=ed[1];entry[PORT]=ed[2];entry[EDGE_ID]=edge;entry[LEADER]=i;
 for(I j=0;j<i;++j)if(a.row(EDGES,w.h(EDGE_BEGIN)+j)[1]==ed[1]){entry[LEADER]=j;break;}
 entry[ALLOCATED]=entry[READY]=0;
 // Identity fields in candidate tokens are immutable after this preparation.
 I* token=entry+TOKEN_DATA;token[0]=ed[1];token[1]=ed[2];token[6]=0;
 for(I j=0;j<w.params;++j)entry[PARAM_DATA+j]=-1;
}

// Token IDs >= OLD_TOKENS denote candidate rows by their original edge index.
// One owner accesses each target. Crucially, other owners inspect only immutable
// target/port fields, never the active/value fields that another owner changes.
JK_HD inline I earliest(Arena a,Workspace w,I target,I port,I key,bool keyed,I through){
 for(I i=0;i<w.h(OLD_TOKENS);++i){I* token=a.row(TOKENS,i);
  if(token[0]!=target)continue;if(token[1]!=port)continue;
  if(token[6]&&(!keyed||token[3]==key))return i;
 }
 for(I i=0;i<=through;++i){I* entry=w.row(i);
  if(entry[TARGET]!=target)continue;if(entry[PORT]!=port)continue;
  I* token=entry+TOKEN_DATA;
  if(entry[ALLOCATED]&&token[6]&&(!keyed||token[3]==key))return w.h(OLD_TOKENS)+i;
 }
 return -1;
}
JK_HD inline I* token(Arena a,Workspace w,I identity){
 return identity<w.h(OLD_TOKENS)?a.row(TOKENS,identity):w.row(identity-w.h(OLD_TOKENS))+TOKEN_DATA;
}
JK_HD inline void match_owner(Arena a,Workspace w,I owner){
 I* first=w.row(owner);if(first[LEADER]!=owner)return;
 I target=first[TARGET];I* node=a.row(NODES,target);I mode=node[6];
 I* event=a.row(EVENTS,w.h(EVENT_ID));I key=event[3];
 for(I i=owner;i<w.h(COUNT);++i){I* entry=w.row(i);if(entry[TARGET]!=target)continue;
  I port=entry[PORT];bool ready=mode==0;
  if(mode!=0){
   I identity=mode==1?earliest(a,w,target,port,key,false,i):-1;
   if(identity<0){identity=w.h(OLD_TOKENS)+i;entry[ALLOCATED]=1;}
   I* value=token(a,w,identity);
   // Do not rewrite target/port even with the same values: other owners read
   // these immutable fields while skipping unrelated historical tokens.
   value[2]=event[2];value[3]=key;value[4]=w.h(EVENT_ID);
   value[5]=entry[EDGE_ID];value[6]=1;value[7]=w.h(OWNER);
   ready=true;
   for(I p=0;p<node[7];++p)if(earliest(a,w,target,p,key,mode==3,i)<0){ready=false;break;}
  }
  if(ready){
   entry[READY]=1;
   if(mode==0)entry[PARAM_DATA+port]=event[2];
   else for(I p=0;p<node[7];++p){I identity=earliest(a,w,target,p,key,mode==3,i);
    I* value=token(a,w,identity);entry[PARAM_DATA+p]=value[2];value[6]=0;
   }
  }
 }
}

JK_HD inline void scan_initialize(Workspace w,I i){
 I* entry=w.row(i);entry[TOKEN_SCAN]=entry[ALLOCATED];entry[TASK_SCAN]=entry[READY];
}
JK_HD inline void scan_prepare(Workspace w,I i,I stride){
 I* entry=w.row(i);I* left=i>=stride?w.row(i-stride):nullptr;
 entry[TOKEN_TEMP]=entry[TOKEN_SCAN]+(left?left[TOKEN_SCAN]:0);
 entry[TASK_TEMP]=entry[TASK_SCAN]+(left?left[TASK_SCAN]:0);
}
JK_HD inline void scan_publish(Workspace w,I i){
 I* entry=w.row(i);entry[TOKEN_SCAN]=entry[TOKEN_TEMP];entry[TASK_SCAN]=entry[TASK_TEMP];
}

// Prefix sums assign compact stable token/task/trace positions before writes.
// Producers may finish in any lane order. Neither FIFO tails nor the logical
// record counts become visible until every producer has joined the barrier.
JK_HD inline void scatter(Arena a,Workspace w,I i){
 I* entry=w.row(i);I* event=a.row(EVENTS,w.h(EVENT_ID));I target=entry[TARGET];I* node=a.row(NODES,target);
 if(entry[ALLOCATED]){
  I* destination=a.row(TOKENS,w.h(OLD_TOKENS)+entry[TOKEN_SCAN]-1);
  for(I k=0;k<8;++k)destination[k]=entry[TOKEN_DATA+k];
 }
 I trace=w.h(TRACE_BEGIN)+i+2*(entry[TASK_SCAN]-entry[READY]);
 entry[TRACE_POSITION]=trace;
 I* edge=a.row(EDGES,entry[EDGE_ID]);
 a.log_at(trace,DELIVERY,w.h(OWNER),target,event[2],w.h(EVENT_ID),entry[PORT],event[3],event[1],edge[3]);
 if(entry[READY]){
  I id=w.h(TASK_BEGIN)+entry[TASK_SCAN]-1;entry[TASK_ID]=id;
  a.prepare_task(id,target,event[3],node[8],w.h(OWNER),w.h(EVENT_ID));
  I* params=a.row(PARAMS,id);for(I p=0;p<w.params;++p)params[p]=entry[PARAM_DATA+p];
  a.log_at(trace+1,MATCH,id,target,-1,w.h(EVENT_ID),-1,event[3]);
  a.log_at(trace+2,ENQUEUE,id,target,-1,w.h(EVENT_ID),-1,event[3]);
 }
}

JK_HD inline void publish(Arena a,Workspace w){
 I count=w.h(COUNT);I* last=w.row(count-1);I added_tokens=last[TOKEN_SCAN],added_tasks=last[TASK_SCAN];
 I groups=0;
 for(I i=0;i<count;++i){I* entry=w.row(i);
  if(entry[LEADER]==i)groups++;
  if(entry[READY])a.link_task(entry[TASK_ID],a.row(NODES,entry[TARGET])[8]);
 }
 a.m(NTOKEN)+=added_tokens;a.m(RES_TOKEN)-=added_tokens;
 a.m(NTASK)+=added_tasks;a.m(RES_TASK)-=added_tasks;
 a.m(NENQUEUE)+=added_tasks;a.m(RCOUNT)+=added_tasks;
 I traces=count+2*added_tasks;a.m(NTRACE)+=traces;a.m(RES_TRACE)-=traces;a.m(DCOUNT)+=count;
 a.row(EVENTS,w.h(EVENT_ID))[4]+=count;
 a.m(LAST_WORK)+=count-(w.h(FAILURE)==4?1:0);
 w.h(BATCHES)++;w.h(EDGES_DONE)+=count;w.h(GROUPS_DONE)+=groups;w.h(TASKS_FORMED)+=added_tasks;
 if(w.h(MAX_BATCH)<count)w.h(MAX_BATCH)=count;
 if(w.h(FAILURE)){a.m(FAULT_POINT)=0;a.m(STOP)=FAILED;a.m(REASON)=w.h(FAILURE);}
}

// Native verification emulates the exact phased algorithm. Reversing the owner
// and scatter loops deliberately exercises independence from producer order;
// it does not claim to prove CUDA barriers or device-memory race freedom.
inline void emulate(Arena a,Workspace w,I maxwork,I maxtasks,I chunk){
 reset(w);a.m(LAST_WORK)=a.m(LAST_COMPLETE)=0;I old=a.m(COMPLETE);
 while(a.m(LAST_WORK)<maxwork&&a.m(STOP)==RUNNABLE&&a.m(COMPLETE)-old<maxtasks){
  if(!available(a)){
   if(!a.advance_one())break;a.m(LAST_WORK)++;continue;
  }
  if(begin(a,w,chunk,maxwork-a.m(LAST_WORK))==0)break;
  I count=w.h(COUNT);
  for(I i=0;i<count;++i)prepare(a,w,i);
  for(I i=count;i>0;--i)match_owner(a,w,i-1);
  for(I i=0;i<count;++i)scan_initialize(w,i);
  for(I stride=1;stride<count;stride*=2){
   for(I i=0;i<count;++i)scan_prepare(w,i,stride);
   for(I i=0;i<count;++i)scan_publish(w,i);
  }
  for(I i=count;i>0;--i)scatter(a,w,i-1);
  publish(a,w);
 }
 a.m(LAST_COMPLETE)=a.m(COMPLETE)-old;
}
} // namespace parallel
