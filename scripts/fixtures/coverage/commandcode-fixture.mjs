// Hand-written fixture in the shape of a minified NDJSON CLI bundle, for the
// extractor test. Event names follow the CLI's output; the code is invented.

// Handed straight to a short-named emitter: listed even if nothing switches on it.
e({type:"run_start",id:1});
fn({type:"tool_running",id:2});
// Built and compared against: listed.
if(x.type==="tool_completed")done();const ok={type:"tool_completed",id:3};
// Built but never switched on: not listed.
const failed={type:"tool_errored",id:4};
// Built and switched on through a case label: listed.
switch(v.type){case"turn_end":break}const end={type:"turn_end",n:1};
// A UI dispatch: neither emitted nor switched on, not listed.
dispatch({type:"select_model",model:m});
