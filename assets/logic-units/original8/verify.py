"""Stage-one JK specification check. No project repository imports or writes."""
from collections import defaultdict, deque
from itertools import product
from pathlib import Path
import hashlib
import json
import re

TOKEN = re.compile(r"([JK])(?:([01])|\(([XQ]\d+)\))")
GATES = {
    "BUF": (1, "J0K(X0)", lambda a: a),
    "NOT": (1, "J0K1K(X0)", lambda a: 1-a),
    "AND2": (2, "J0K1J(X0)J(X1)", lambda a,b: a & b),
    "OR2": (2, "J0K1K(X0)J(X1)K(X0)", lambda a,b: a | b),
    "NAND2": (2, "J0K1J(X0)J(X1)K1", lambda a,b: 1-(a & b)),
    "NOR2": (2, "J0K1K(X0)J(X1)K(X0)K1", lambda a,b: 1-(a | b)),
    "XOR2": (2, "J0K(X0)K(X1)", lambda a,b: a ^ b),
    "XNOR2": (2, "J0K1K(X0)K(X1)", lambda a,b: 1-(a ^ b)),
}

def tokens(ex):
    out=[]; pos=0
    while pos < len(ex):
        m=TOKEN.match(ex,pos)
        if not m: raise ValueError("invalid token")
        out.append((m[1], int(m[2]) if m[2] is not None else m[3]))
        pos=m.end()
    if not out or not any(isinstance(v,str) for _,v in out):
        raise ValueError("empty or constant-only expression")
    return out

def evaluate(ts, old_q, read):
    q=old_q
    for op,source in ts:
        value=source if isinstance(source,int) else read(source)
        q=(q & value) if op == "J" else (q ^ value)
    return q

def validate(nodes, initial, input_bits):
    names=[f"Q{i}" for i in range(len(nodes))]
    initialized=initial.get("0",[])+initial.get("1",[])
    if len(set(initialized)) != len(initialized) or not set(initialized)<=set(names):
        raise ValueError("duplicate/conflicting/unknown initial state")
    state=set(initialized)
    parsed={name:tokens(ex) for name,ex in zip(names,nodes)}
    refs={name:{v for _,v in ts if isinstance(v,str)} for name,ts in parsed.items()}
    barriers={name:{v for v in rr if v.startswith("Q") and v not in state} for name,rr in refs.items()}
    edges=defaultdict(set)
    for name,ex in zip(names,nodes):
        if name not in state and parsed[name][0] != ("J",0):
            raise ValueError("stateless node must start J0")
        for ref in refs[name]:
            if ref.startswith("X"):
                if int(ref[1:])>=input_bits: raise ValueError("input reference out of range")
            else:
                if ref not in names: raise ValueError("node reference out of range")
                if not barriers[name] and int(ref[1:])>=int(name[1:]):
                    raise ValueError("state reference order")
                if ref not in state: edges[ref].add(name)
    pending=set(names)
    while pending:
        ready={q for q in pending if not any(q in edges[s] for s in pending)}
        if not ready: raise ValueError("stateless arrival cycle")
        pending-=ready
    return parsed,refs,barriers,state

class Network:
    def __init__(self,nodes,initial,input_bits,old_x=None,old_q=None):
        self.parsed,self.refs,self.barriers,self.state=validate(nodes,initial,input_bits)
        self.x={f"X{i}":0 for i in range(input_bits)}
        if old_x is not None: self.x.update({f"X{i}":x for i,x in enumerate(old_x)})
        self.q={name:0 for name in self.parsed}
        for value in ("0","1"):
            for name in initial.get(value,[]): self.q[name]=int(value)
        if old_q: self.q.update(old_q)
        self.cache={name:{} for name in self.parsed}
        self.targets=defaultdict(list)
        for name,refs in self.refs.items():
            for source in refs: self.targets[source].append(name)
        for targets in self.targets.values(): targets.sort(key=lambda q:int(q[1:]))
        self.queue=deque()
        self.trace=[]; self.exec_trace=[]

    def send(self,row):
        assert len(row)==len(self.x) and not self.queue
        self.trace=[]; self.exec_trace=[]
        self.queue.extend((f"X{i}",v) for i,v in enumerate(row))
        while self.queue:
            if len(self.trace)>=10000: raise AssertionError("queue did not drain within test guard")
            source,value=self.queue.popleft()
            self.trace.append((source,value))
            if source.startswith("X"): self.x[source]=value
            # Q events never roll back global q. Stateless events use per-link caches.
            for target in self.targets[source]:
                barrier=self.barriers[target]
                if barrier:
                    if source not in barrier: continue
                    self.cache[target][source]=value
                    if set(self.cache[target]) != barrier: continue
                    captured=dict(self.cache[target])
                    self.cache[target].clear()
                else:
                    captured={}
                def read(ref):
                    if ref.startswith("X"): return self.x[ref]
                    if ref in self.state: return self.q[ref]
                    return captured[ref]
                old=self.q[target]
                new=evaluate(self.parsed[target],old,read)
                self.q[target]=new
                self.exec_trace.append((target,old,new))
                self.queue.append((target,new))
        return list(self.trace)

def emissions(net,name): return [new for target,old,new in net.exec_trace if target==name]
def initial_for(stateful,old): return {"0":["Q0"] if stateful and old==0 else [],"1":["Q0"] if stateful and old==1 else []}
def expected_values(fun,old_x,new_x):
    working=list(old_x); values=[]
    for i,value in enumerate(new_x):
        working[i]=value; values.append(fun(*working))
    return values

def run():
    counts=defaultdict(int); tables={}; examples={}; minimal=[]
    for name,(arity,ex,fun) in GATES.items():
        ts=tokens(ex)
        rows=list(product((0,1),repeat=arity))
        tables[name]=[{"inputs":list(row),"output":fun(*row)} for row in rows]
        for row in rows:
            for old in (0,1):
                assert evaluate(ts,old,dict(zip([f"X{i}" for i in range(arity)],row)).__getitem__)==fun(*row)
                counts["expression_truth_cases"]+=1
        # All base and declared-state realizations are structurally checked.
        for initial in ({"0":[],"1":[]},{"0":["Q0"],"1":[]},{"0":[],"1":["Q0"]}):
            validate([ex],initial,arity); counts["valid_gate_declarations"]+=1
        minimal.append({"name":name,"nodes":[{"id":"Q0","ex":ex}],"initial_q":{"0":[],"1":[]},"q_y":[{"Y0":"Q0"}],"inputs":[{f"X{i}":f"X{i}"} for i in range(arity)],"outputs":[{"Y0":"Y0"}]})
        for old_x,new_x,old_q,stateful in product(rows,rows,(0,1),(False,True)):
            initial=initial_for(stateful,old_q)
            net=Network([ex],initial,arity,old_x,{"Q0":old_q})
            expected=expected_values(fun,old_x,new_x)
            trace=net.send(new_x)
            assert emissions(net,"Q0")==expected
            assert trace==[(f"X{i}",v) for i,v in enumerate(new_x)]+[("Q0",v) for v in expected]
            assert net.q["Q0"]==fun(*new_x)
            assert all(not c for c in net.cache.values())
            counts["isolated_first_sends"]+=1
            trace=net.send(new_x)
            repeated=[fun(*new_x)]*arity
            assert emissions(net,"Q0")==repeated
            assert trace==[(f"X{i}",v) for i,v in enumerate(new_x)]+[("Q0",v) for v in repeated]
            counts["same_value_repeat_sends"]+=1
            cascade=Network([ex,"J0K1K(Q0)"],initial,arity,old_x,{"Q0":old_q})
            cascade.send(new_x)
            expected_sink=[1-v for v in expected] if not stateful else [1-expected[-1]]*arity
            assert emissions(cascade,"Q0")==expected
            assert emissions(cascade,"Q1")==expected_sink
            assert len(cascade.trace)==arity*3 and all(not c for c in cascade.cache.values())
            counts["native_not_cascade_sends"]+=1
    # Latest actual q with a stateless barrier source.
    for old_x,new_x,old_q in product(product((0,1),repeat=2),product((0,1),repeat=2),(0,1)):
        net=Network([GATES["XOR2"][1],"J0K(X0)","J0K(Q0)K(Q1)"],initial_for(True,old_q),2,old_x)
        net.send(new_x)
        assert emissions(net,"Q2")==[new_x[1]]
        assert len(emissions(net,"Q0"))==2 and all(not c for c in net.cache.values())
        counts["latest_q_with_barrier_sends"]+=1
    # User's explicit synchronization example, using initial_q-based classification.
    sync_nodes=["J0K(X0)","J0K(X1)","J0K(Q0)","J0K(Q1)","J0J(Q2)J(Q3)J0","J0K(Q0)K(Q1)K(Q4)"]
    for old_x,new_x,saved in product(product((0,1),repeat=2),product((0,1),repeat=2),product((0,1),repeat=3)):
        initial={"0":[],"1":[]}
        for q,value in zip(("Q0","Q1","Q5"),saved): initial[str(value)].append(q)
        net=Network(sync_nodes,initial,2,old_x)
        assert net.state=={"Q0","Q1","Q5"} and net.barriers["Q5"]=={"Q4"}
        for _ in range(2):
            trace=net.send(new_x)
            assert [s for s,v in trace]==["X0","X1","Q0","Q1","Q2","Q3","Q4","Q5"]
            assert [emissions(net,f"Q{i}") for i in range(6)]==[[new_x[0]],[new_x[1]],[new_x[0]],[new_x[1]],[0],[new_x[0]^new_x[1]]]
            assert not any(net.cache.values())
            counts["explicit_sync_example_sends"]+=1
    # Directed counterexample: stateful references see newest q, stateless links see event values.
    for source_state in (False,True):
        init=initial_for(source_state,0)
        init["0"].append("Q1")
        net=Network([GATES["XOR2"][1],"K(Q0)"],init,2,[0,0])
        net.send([1,1])
        assert emissions(net,"Q0")==[1,0]
        assert emissions(net,"Q1")==([1,1] if not source_state else [0,0])
        examples["xor_into_accumulator_"+("stateful" if source_state else "stateless")]=net.trace
        counts["accumulator_classification_sends"]+=1
    invalid=[([""],{"0":[],"1":[]},1),(["J0"],{"0":[],"1":[]},1),(["K1"],{"0":["Q0"],"1":[]},1),(["K(X0)"],{"0":[],"1":[]},1),(["J0 K(X0)"],{"0":[],"1":[]},1),(["J0K(X1)"],{"0":[],"1":[]},1),(["J0K(Q1)"],{"0":[],"1":[]},1),(["J0K(X0)"],{"0":["Q0"],"1":["Q0"]},1),(["J0K(Q0)"],{"0":[],"1":[]},1),(["J0K(Q1)","J0K(X0)"],{"0":["Q1"],"1":[]},1)]
    for args in invalid:
        try: validate(*args)
        except ValueError: counts["invalid_structures_rejected"]+=1
        else: raise AssertionError("invalid structure accepted")
    counts["fifo_sends_total"]=sum(counts[k] for k in ("isolated_first_sends","same_value_repeat_sends","native_not_cascade_sends","latest_q_with_barrier_sends","explicit_sync_example_sends","accumulator_classification_sends"))
    report={"status":"PASS","basis":"JK规则与设计 current_sequence 87; initial_q-based state classification; native FIFO; latest actual state q","counts":dict(counts),"truth_tables":tables,"directed_examples":examples,"limits":["Independent specification checker, not JK_NET or ModelShow integration tests","No claim of global minimization or arbitrary-network equivalence","Minimal structures omit standard export metadata and hashes","FIFO tests start with empty arrival caches; do not prove arbitrary residual-cache behavior"],"script_sha256":hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}
    folder=Path(__file__).parent
    (folder/"results.json").write_text(json.dumps(report,ensure_ascii=False,indent=2)+"\n")
    (folder/"minimal_gate_structures.json").write_text(json.dumps(minimal,ensure_ascii=False,indent=2)+"\n")
    print(json.dumps({"status":report["status"],"counts":dict(counts),"script_sha256":report["script_sha256"]},ensure_ascii=False,indent=2))

if __name__=="__main__": run()
