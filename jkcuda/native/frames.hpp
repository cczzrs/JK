#pragma once

// Included inside namespace jk, after the shared section/phase declarations.
// Every business mutation here runs as the selected FIFO task on the device.
// Host code only owns ingress storage and submits completion facts.
namespace frame {
constexpr I MAGIC = 0x4a4b4652414d45LL, VERSION = 1, HEADER = 32;
enum Header { USED=0, SIGNATURE, REVISION, BLOCK_CAPACITY, INPUT_QUEUE,
 CONTROL_QUEUE, HEAD, TAIL, NEXT_FRAME, NEXT_BATCH, FRAME_COUNT, FIRST_FRAME,
 LAST_FRAME, DATA_NODE, DATA_PARAM, MARKER_NODE, MARKER_PARAM, BLOCK_COUNT,
 FIRST_BLOCK, LAST_BLOCK, MAX_WIDTH, UNUSED21, FIRST_BATCH, LAST_BATCH,
 TASK_CREDIT, TRACE_CREDIT, WORD_CREDIT, BIZ_PRE_HEAD, BIZ_PRE_TAIL,
 BIZ_ACTIVE_FRAME, BIZ_CONFIG_PTR, BIZ_PROFILE_COUNT };
enum Frame { F_NEXT=0,F_QUEUE_NEXT,F_ID,F_GEN,F_BLOCK,F_SLOT,F_SLOT_GEN,F_WIDTH,
 F_ARRIVED,F_STORED,F_CONSUMED,F_QUALIFIED,F_TOKEN,F_NEXT_TOKEN,F_FIRST_BATCH,
 F_DATA,F_RETAINED,F_VALID,F_HOLD,F_KEY,F_RESERVED20,F_RESERVED21,F_SIZE };
enum Block { B_NEXT=0,B_ID,B_GEN,B_USED,B_LIVE,B_HOLD,B_SIZE };
enum Batch { O_NEXT=0,O_ID,O_FRAME,O_FRAME_GEN,O_SLOT_GEN,O_TOKEN,O_REPLAY,
 O_WIDTH,O_COMMITTED,O_RECEIVED,O_HOST_ENQUEUED,O_MARKER_OUTPUT,O_RECORDS,
 O_RESERVED13,O_RESERVED14,O_RESERVED15,O_SIZE };
enum Record { R_BATCH=0,R_POSITION,R_EXPECTED,R_VALUE,R_OUTPUT,R_DONE,R_SIZE };
enum Opcode { INPUT_BIT=1, STORE=2, ACK_DEC=3, ACK_ACT=4, COMPLETE=5, PRE_ACCEPT=6, CLAIM=7 };
enum BusinessProfile { P_INPUT_WIDTH=0,P_OUTPUT_WIDTH,P_PRE_NODES,P_FINISH_NODE,
 P_FINISH_PARAMS,P_RESERVED,P_SIZE };
enum BusinessContext { C_PRE_NEXT=0,C_PROFILE,C_INPUT_WIDTH,C_RAW,C_RAW_VALID,C_STAGE,
 C_OWNER,C_FINISH_TASK,C_CLAIM_TASK,C_RESERVED,C_SIZE };
constexpr I OUTPUT_TAG=-101;

template<class A> JK_HD I* blob(A& a) { return a.row(FRAMES,0); }
template<class A> JK_HD bool configured(A& a) {
 return a.cap(FRAMES)>=HEADER && blob(a)[USED]>=HEADER && blob(a)[SIGNATURE]==MAGIC;
}
template<class A> JK_HD bool business_configured(A& a) {
 return configured(a)&&blob(a)[BIZ_CONFIG_PTR]>=HEADER&&blob(a)[BIZ_PROFILE_COUNT]>0;
}
template<class A> JK_HD I business_finish_profile(A& a,I node) {
 if(!business_configured(a))return -1;
 I* b=blob(a);I* n=a.row(NODES,node);
 for(I i=0;i<b[BIZ_PROFILE_COUNT];++i){I at=b[BIZ_CONFIG_PTR]+i*P_SIZE;
  I* registered=a.row(NODES,b[at+P_FINISH_NODE]);
  if(registered[16]==n[16]&&registered[13]==n[13])return at;
 }
 return -1;
}
template<class A> JK_HD bool protocol_failure(A& a) {
 a.m(STOP)=FAILED;a.m(REASON)=5;return false;
}
template<class A> JK_HD I allocate(A& a,I count) {
 I* b=blob(a);I at=b[USED];b[USED]+=count;
 for(I i=0;i<count;++i)b[at+i]=-1;
 return at;
}
template<class A> JK_HD bool space(A& a,I words,I tasks,I traces) {
 I* b=blob(a);
 return a.room(FRAMES,b[USED],words) &&
        a.room(TASKS,a.m(NTASK)+a.m(RES_TASK),tasks) &&
        a.room(TRACES,a.m(NTRACE)+a.m(RES_TRACE),traces);
}
template<class A> JK_HD I control(A& a,I parent,I opcode,I payload) {
 I* b=blob(a);I t=a.append(-3,-1,b[CONTROL_QUEUE],parent,-1);
 I* task=a.row(TASKS,t);task[14]=payload;task[15]=opcode;
 I* p=a.row(PARAMS,t);for(I i=0;i<a.width(PARAMS);++i)p[i]=-1;
 a.log(ENQUEUE,t,-3);return t;
}
template<class A> JK_HD bool output_space(A& a,I width,I extra_words=0) {
 if(blob(a)[NEXT_BATCH]>=0x7fffffffffffffffLL){a.m(STOP)=FAILED;a.m(REASON)=6;return false;}
 return space(a,O_SIZE+(width+1)*R_SIZE+extra_words+4,width+2,width+4);
}
template<class A> JK_HD I emit(A& a,I parent,I frame_at,bool replay) {
 I* b=blob(a);I* f=b+frame_at;I width=f[F_WIDTH];
 I at=allocate(a,O_SIZE+(width+1)*R_SIZE);I* batch=b+at;
 batch[O_NEXT]=-1;batch[O_ID]=b[NEXT_BATCH]++;batch[O_FRAME]=frame_at;
 batch[O_FRAME_GEN]=f[F_GEN];batch[O_SLOT_GEN]=f[F_SLOT_GEN];
 batch[O_TOKEN]=replay?f[F_TOKEN]:f[F_NEXT_TOKEN]++;
 batch[O_REPLAY]=replay?1:0;batch[O_WIDTH]=width;batch[O_COMMITTED]=0;
 batch[O_RECEIVED]=0;batch[O_HOST_ENQUEUED]=0;batch[O_MARKER_OUTPUT]=-1;
 batch[O_RECORDS]=at+O_SIZE;
 if(b[LAST_BATCH]>=0)b[b[LAST_BATCH]+O_NEXT]=at;else b[FIRST_BATCH]=at;
 b[LAST_BATCH]=at;f[F_HOLD]++;b[f[F_BLOCK]+B_HOLD]++;
 b[TASK_CREDIT]++;b[TRACE_CREDIT]++;b[WORD_CREDIT]+=4;
 if(!replay)f[F_FIRST_BATCH]=at;
 I payload=replay?f[F_RETAINED]:f[F_DATA];
 for(I position=0;position<=width;++position){
  I record_at=batch[O_RECORDS]+position*R_SIZE;I* record=b+record_at;
  I marker=position==width,node=marker?b[MARKER_NODE]:b[DATA_NODE];
  I value=marker?(replay?0:1):b[payload+position];
  record[R_BATCH]=at;record[R_POSITION]=position;record[R_EXPECTED]=value;
  record[R_VALUE]=-1;record[R_OUTPUT]=-1;record[R_DONE]=0;
  I task_id=a.append(node,f[F_KEY],b[CONTROL_QUEUE],parent,-1);
  I* task=a.row(TASKS,task_id);task[14]=record_at;task[15]=OUTPUT_TAG;
  I* params=a.row(PARAMS,task_id);for(I i=0;i<a.width(PARAMS);++i)params[i]=-1;
  params[marker?b[MARKER_PARAM]:b[DATA_PARAM]]=value;
  a.log(ENQUEUE,task_id,node,-1,-1,-1,f[F_KEY]);
 }
 return at;
}
template<class A> JK_HD I usable_block(A& a) {
 I* b=blob(a);
 for(I at=b[FIRST_BLOCK];at>=0;at=b[at+B_NEXT]){
  I* block=b+at;
  if(block[B_USED]<b[BLOCK_CAPACITY] ||
     (block[B_LIVE]==0&&block[B_HOLD]==0&&block[B_GEN]<0x7fffffffffffffffLL))return at;
 }
 return -1;
}
} // namespace frame

// FINISH is an ordinary declared JK task with already-latched POST parameters.
// These hooks only transfer those computed values and publish the declared
// STORE/CLAIM control tasks. They never execute another node's EX.
template<class A> JK_HD bool frame_business_reservation(A& a,I task_id,I node,I& tasks,I& traces) {
 using namespace frame;
 I profile=business_finish_profile(a,node);if(profile<0)return true;
 I* task=a.row(TASKS,task_id);I* b=blob(a);I at=b[BIZ_ACTIVE_FRAME];
 if(task[0]!=node||task[12]>=0||at<frame::HEADER)return protocol_failure(a);
 I* f=b+at;if(f[F_RESERVED20]<frame::HEADER)return protocol_failure(a);
 I* context=b+f[F_RESERVED20];I* p=b+profile;
 if(context[C_STAGE]!=3||context[C_OWNER]!=at||context[C_PROFILE]!=profile||
    task[1]!=f[F_KEY]||p[P_OUTPUT_WIDTH]!=f[F_WIDTH]||
    f[F_ARRIVED]!=context[C_INPUT_WIDTH])return protocol_failure(a);
 for(I i=0;i<p[P_OUTPUT_WIDTH];++i){I index=b[p[P_FINISH_PARAMS]+i];
  if(index<0||index>=a.width(PARAMS))return protocol_failure(a);
  I value=a.row(PARAMS,task_id)[index];if(value!=0&&value!=1)return protocol_failure(a);
 }
 I next=b[BIZ_PRE_HEAD];
 if(next>=0){I* n=b+next;
  if(n[F_RESERVED20]<frame::HEADER||b[n[F_RESERVED20]+C_STAGE]!=1)return protocol_failure(a);
 }
 I additional=next>=0?2:1;tasks+=additional;traces+=additional;
 return true;
}
template<class A> JK_HD void frame_business_commit(A& a,I task_id,I node) {
 using namespace frame;
 I profile=business_finish_profile(a,node);if(profile<0)return;
 I* b=blob(a);I at=b[BIZ_ACTIVE_FRAME];I* f=b+at;I* context=b+f[F_RESERVED20];I* p=b+profile;
 for(I i=0;i<p[P_OUTPUT_WIDTH];++i){
  b[f[F_DATA]+i]=a.row(PARAMS,task_id)[b[p[P_FINISH_PARAMS]+i]];b[f[F_VALID]+i]=1;
 }
 context[C_STAGE]=4;context[C_FINISH_TASK]=task_id;b[BIZ_ACTIVE_FRAME]=-1;
 control(a,task_id,STORE,at);a.m(RES_TASK)--;a.m(RES_TRACE)--;
 I next=b[BIZ_PRE_HEAD];
 if(next>=0){b[b[next+F_RESERVED20]+C_STAGE]=2;control(a,task_id,CLAIM,next);
  a.m(RES_TASK)--;a.m(RES_TRACE)--;
 }
}

template<class A> JK_HD void frame_capture_output(A& a,I task_id,I node,I value,I output_id) {
 I* task=a.row(TASKS,task_id);
 if(task[15]!=frame::OUTPUT_TAG)return;
 I* b=frame::blob(a);I* record=b+task[14];I* batch=b+record[frame::R_BATCH];
 // Space and ownership were fixed before the output task was enqueued. This
 // hook cannot allocate, fail, or make ACK qualification visible.
 record[frame::R_VALUE]=value;record[frame::R_OUTPUT]=output_id;record[frame::R_DONE]=1;
 batch[frame::O_COMMITTED]++;
 if(record[frame::R_POSITION]==batch[frame::O_WIDTH])batch[frame::O_MARKER_OUTPUT]=output_id;
 (void)node;
}

template<class A> JK_HD bool frame_execute(A& a,I task_id) {
 using namespace frame;
 I* b=blob(a);I* task=a.row(TASKS,task_id);I opcode=task[15],at=task[14];
 if(!configured(a)){a.m(STOP)=FAILED;a.m(REASON)=5;return false;}
 // Each control program has a bounded atomic device step. Reserve everything
 // before its first mutation; a failed retry remains the same selected task.
 if(opcode==INPUT_BIT){
  I frame_at=b[at],position=b[at+1],value=b[at+2];I* f=b+frame_at;
  bool business=f[F_RESERVED20]>=frame::HEADER;
  I* context=business?b+f[F_RESERVED20]:nullptr;
  I width=business?context[C_INPUT_WIDTH]:f[F_WIDTH];
  bool final=f[F_ARRIVED]+1==width;
  if(!space(a,0,final?1:0,final?4:3))return false;
  if(a.fault(1))return false;
  // Registered input adapter EX: J0K(PARAM). Zero is ordinary data.
  I q=0;q^=value;
  I data=business?context[C_RAW]:f[F_DATA],valid=business?context[C_RAW_VALID]:f[F_VALID];
  b[data+position]=q;b[valid+position]=1;f[F_ARRIVED]++;
  a.log(BIND,task_id,-3,0);a.log(COMMIT,task_id,-3,q);a.m(EXCOUNT)++;
  if(final)control(a,task_id,business?PRE_ACCEPT:STORE,frame_at);
 } else if(opcode==PRE_ACCEPT){
  I* f=b+at;
  if(!business_configured(a)||f[F_RESERVED20]<frame::HEADER)return protocol_failure(a);
  I* context=b+f[F_RESERVED20];
  if(context[C_STAGE]!=0||context[C_OWNER]!=at||f[F_ARRIVED]!=context[C_INPUT_WIDTH])return protocol_failure(a);
  I head=b[BIZ_PRE_HEAD];I head_stage=head>=0?b[b[head+F_RESERVED20]+C_STAGE]:-1;
  if(head>=0&&head_stage!=1&&head_stage!=2)return protocol_failure(a);
  bool claim=b[BIZ_ACTIVE_FRAME]<0&&(head<0||head_stage==1);
  if(!space(a,0,claim?1:0,claim?3:2))return false;
  if(a.fault(1))return false;
  context[C_PRE_NEXT]=-1;context[C_STAGE]=1;
  if(b[BIZ_PRE_TAIL]>=0)b[b[b[BIZ_PRE_TAIL]+F_RESERVED20]+C_PRE_NEXT]=at;
  else b[BIZ_PRE_HEAD]=at;
  b[BIZ_PRE_TAIL]=at;
  if(claim){I first=b[BIZ_PRE_HEAD];b[b[first+F_RESERVED20]+C_STAGE]=2;control(a,task_id,CLAIM,first);}
  a.log(COMMIT,task_id,-3,f[F_ID]);
 } else if(opcode==CLAIM){
  I* f=b+at;
  if(!business_configured(a)||f[F_RESERVED20]<frame::HEADER||b[BIZ_PRE_HEAD]!=at||b[BIZ_ACTIVE_FRAME]>=0)return protocol_failure(a);
  I* context=b+f[F_RESERVED20];I* profile=b+context[C_PROFILE];I width=context[C_INPUT_WIDTH];
  if(context[C_STAGE]!=2||context[C_OWNER]!=at||profile[P_INPUT_WIDTH]!=width||f[F_ARRIVED]!=width)return protocol_failure(a);
  for(I i=0;i<width;++i)if(b[context[C_RAW_VALID]+i]!=1||(b[context[C_RAW]+i]!=0&&b[context[C_RAW]+i]!=1))return protocol_failure(a);
  if(!space(a,0,width,width+2))return false;
  if(a.fault(1))return false;
  b[BIZ_PRE_HEAD]=context[C_PRE_NEXT];if(b[BIZ_PRE_HEAD]<0)b[BIZ_PRE_TAIL]=-1;
  context[C_PRE_NEXT]=-1;context[C_STAGE]=3;context[C_CLAIM_TASK]=task_id;b[BIZ_ACTIVE_FRAME]=at;
  for(I i=0;i<width;++i){I node=b[profile[P_PRE_NODES]+i];I generated=a.append(node,f[F_KEY],a.row(NODES,node)[8],task_id,-1);
   I* params=a.row(PARAMS,generated);for(I p=0;p<a.width(PARAMS);++p)params[p]=-1;
   params[0]=b[context[C_RAW]+i];a.log(ENQUEUE,generated,node,-1,-1,-1,f[F_KEY]);
  }
  a.log(COMMIT,task_id,-3,f[F_ID]);
 } else if(opcode==STORE){
  I* f=b+at;I block_at=usable_block(a);bool new_block=block_at<0;
  if(new_block&&b[BLOCK_COUNT]>=0x7fffffffffffffffLL){a.m(STOP)=FAILED;a.m(REASON)=6;return false;}
  bool first=b[HEAD]<0;I words=(new_block?B_SIZE:0);
  if(first){if(!output_space(a,f[F_WIDTH],words))return false;}
  else if(!space(a,words,0,2))return false;
  if(a.fault(1))return false;
  if(new_block){
   block_at=allocate(a,B_SIZE);I* block=b+block_at;
   block[B_NEXT]=-1;block[B_ID]=++b[BLOCK_COUNT];block[B_GEN]=1;
   block[B_USED]=block[B_LIVE]=block[B_HOLD]=0;
   if(b[LAST_BLOCK]>=0)b[b[LAST_BLOCK]+B_NEXT]=block_at;else b[FIRST_BLOCK]=block_at;
   b[LAST_BLOCK]=block_at;
  }
  I* block=b+block_at;
  if(block[B_USED]==b[BLOCK_CAPACITY]){block[B_GEN]++;block[B_USED]=0;}
  f[F_BLOCK]=block_at;f[F_SLOT]=block[B_USED]++;f[F_SLOT_GEN]=block[B_GEN];
  block[B_LIVE]++;f[F_STORED]=1;f[F_QUEUE_NEXT]=-1;
  if(b[TAIL]>=0)b[b[TAIL]+F_QUEUE_NEXT]=at;else b[HEAD]=at;
  b[TAIL]=at;
  if(first)emit(a,task_id,at,false);
  a.log(COMMIT,task_id,-3,f[F_ID]);
 } else if(opcode==ACK_DEC){
  I frame_at=b[HEAD];I* f=frame_at>=0?b+frame_at:nullptr;
  bool qualified=f&&f[F_QUALIFIED]&&!f[F_CONSUMED];
  if(!space(a,qualified?5:0,qualified?1:0,qualified?3:2))return false;
  if(a.fault(1))return false;
  if(qualified){I action=allocate(a,5);b[action]=frame_at;b[action+1]=f[F_GEN];
   b[action+2]=f[F_SLOT_GEN];b[action+3]=f[F_TOKEN];b[action+4]=b[at];
   control(a,task_id,ACK_ACT,action);
  }
  a.log(COMMIT,task_id,-3,qualified?1:0);
 } else if(opcode==ACK_ACT){
  I frame_at=b[at];I* f=b+frame_at;I ack=b[at+4];
  bool valid=frame_at==b[HEAD]&&!f[F_CONSUMED]&&f[F_QUALIFIED]&&
   f[F_GEN]==b[at+1]&&f[F_SLOT_GEN]==b[at+2]&&f[F_TOKEN]==b[at+3];
  I next=valid?(ack==0?frame_at:f[F_QUEUE_NEXT]):-1;
  if(next>=0){if(!output_space(a,b[next+F_WIDTH]))return false;}
  else if(!space(a,0,0,2))return false;
  if(a.fault(1))return false;
  if(valid){
   if(ack==0)emit(a,task_id,frame_at,true);
   else {f[F_CONSUMED]=1;f[F_QUALIFIED]=0;f[F_TOKEN]=0;
    b[f[F_BLOCK]+B_LIVE]--;b[HEAD]=f[F_QUEUE_NEXT];
    if(b[HEAD]<0)b[TAIL]=-1;else emit(a,task_id,b[HEAD],false);
   }
  }
  a.log(COMMIT,task_id,-3,valid?1:0);
 } else if(opcode==frame::COMPLETE){
  I batch_at=b[at];I* batch=b+batch_at;I* f=b+batch[O_FRAME];
  if(!space(a,0,0,2))return false;
  if(a.fault(1))return false;
  bool matched=batch[O_FRAME_GEN]==b[at+1]&&batch[O_SLOT_GEN]==b[at+2]&&
   batch[O_MARKER_OUTPUT]==b[at+3]&&batch[O_COMMITTED]==batch[O_WIDTH]+1;
  if(matched&&!batch[O_RECEIVED]){
   batch[O_RECEIVED]=1;f[F_HOLD]--;b[f[F_BLOCK]+B_HOLD]--;
   if(!batch[O_REPLAY]&&!f[F_CONSUMED]&&b[HEAD]==batch[O_FRAME]&&
      f[F_GEN]==batch[O_FRAME_GEN]&&f[F_SLOT_GEN]==batch[O_SLOT_GEN]){
    for(I i=0;i<f[F_WIDTH];++i)b[f[F_RETAINED]+i]=b[batch[O_RECORDS]+i*R_SIZE+R_VALUE];
    f[F_QUALIFIED]=1;f[F_TOKEN]=batch[O_TOKEN];
   }
  }
  a.log(COMMIT,task_id,-3,matched?1:0);
 } else {a.m(STOP)=FAILED;a.m(REASON)=5;return false;}
 task[7]=a.m(NEVENT);task[8]=task[9]=0;task[4]=PROPAGATING;
 a.m(ROOT_VERSION)++;
 if(a.fault(2))return false;
 return true;
}
