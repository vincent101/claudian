'use strict';

// Synthetic protocol peer, not a recording of a CLI or evidence of CLI behavior.
const fs = require('node:fs');
const readline = require('node:readline');
const trace = process.env.A3_TRACE;
const log = (event) => fs.appendFileSync(trace, `${JSON.stringify(event)}\n`);
const send = (message) => {
  log({ event: 'wire', message });
  process.stdout.write(`${JSON.stringify(message)}\n`);
};
const result = (uuid, subtype, extra) => ({
  type: 'result', subtype, uuid, session_id: 'synthetic-session',
  duration_ms: 0, duration_api_ms: 0, is_error: subtype !== 'success', num_turns: 0, stop_reason: null,
  total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  modelUsage: {}, permission_denials: [], ...(subtype === 'success' ? { result: '' } : { errors: ['synthetic error'] }), ...extra,
});
const samples = [
  result('a3-success', 'success', { user_message_uuid: 'H', user_message_uuids: ['H'], result_index: 0, queued_turn_count: 1 }),
  result('a3-batch', 'success', { user_message_uuid: 'H', user_message_uuids: ['H', 'N'], result_index: 1, queued_turn_count: 0 }),
  result('a3-absent', 'success', {}),
  result('a3-conflict', 'success', { user_message_uuid: 'H', user_message_uuids: ['N'], result_index: 2, queued_turn_count: 3 }),
  result('a3-invalid', 'error_during_execution', { user_message_uuid: null, user_message_uuids: 'bad', result_index: 'bad', queued_turn_count: null }),
  result('a3-empty', 'error_during_execution', { user_message_uuid: 42, user_message_uuids: [], result_index: -1, queued_turn_count: 'bad' }),
  result('a3-execution-error', 'error_during_execution', { user_message_uuid: 'H', user_message_uuids: ['H'], errors: ['synthetic execution error'] }),
  result('a3-delivery-failure', 'error_during_execution', { user_message_uuid: 'H', errors: ['synthetic delivery failure'] }),
  result('a3-zeroed-error', 'error_during_execution', {}),
  { type: 'system', subtype: 'task_notification', uuid: 'a3-task', session_id: 'synthetic-session', task_id: 'T', status: 'completed', output_file: '/synthetic', summary: 'synthetic', run_id: 'run-synthetic', level: 'ambient' },
];
log({ event: 'start', pid: process.pid });
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let sawUser = false;
let stopCallbackId;
input.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { log({ event: 'invalid-json' }); process.exitCode = 2; input.close(); return; }
  if (msg.type === 'control_request') {
    const subtype = msg.request?.subtype;
    log({ event: 'control', subtype, request_id: msg.request_id });
    if (subtype === 'initialize') {
      stopCallbackId = msg.request.hooks?.Stop?.[0]?.hookCallbackIds?.[0];
      log({ event: 'stop-registration', callback_id: stopCallbackId ?? null });
      const id = process.env.A3_BAD_INIT ? 'wrong-request-id' : msg.request_id;
      send({ type: 'control_response', response: { subtype: 'success', request_id: id, response: { commands: [{ name: 'a3-init-canary', description: 'synthetic handshake canary', argumentHint: '' }], agents: [], output_style: 'default', available_output_styles: ['default'], models: [], account: {} } } });
      send({ type: 'system', subtype: 'init', session_id: 'synthetic-session', uuid: 'a3-init', cwd: process.cwd(), model: 'synthetic' });
    } else if (subtype === 'mcp_set_servers') {
      send({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: { added: [], removed: [], errors: {} } } });
    } else if (['set_model', 'set_permission_mode', 'set_max_thinking_tokens', 'apply_flag_settings'].includes(subtype)) {
      send({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: {} } });
    } else {
      log({ event: 'unknown-control', subtype });
      send({ type: 'control_response', response: { subtype: 'error', request_id: msg.request_id, error: `unsupported synthetic control: ${subtype}` } });
      process.exitCode = 2; input.close();
    }
  } else if (msg.type === 'user') {
    log({ event: 'user', uuid: msg.uuid ?? null, message: msg.message });
    if (sawUser) { log({ event: 'unexpected-second-user' }); process.exitCode = 2; input.close(); return; }
    sawUser = true;
    for (const item of samples) {
      const copy = { ...item };
      if (process.env.A3_DROP_FIELD && copy.uuid === 'a3-success') delete copy.user_message_uuids;
      send(copy);
    }
    if (stopCallbackId) {
      send({ type: 'control_request', request_id: 'a3-hook-request', request: { subtype: 'hook_callback', callback_id: stopCallbackId, input: { session_id: 'synthetic-session', transcript_path: '/synthetic', cwd: process.cwd(), hook_event_name: 'Stop', stop_hook_active: false } } });
    }
  } else if (msg.type === 'control_response') {
    log({ event: 'control-response', request_id: msg.response?.request_id, response: msg.response });
  } else {
    log({ event: 'unknown-message', type: msg.type }); process.exitCode = 2; input.close();
  }
});
input.on('close', () => { log({ event: 'stdin-closed', code: process.exitCode ?? 0 }); });
