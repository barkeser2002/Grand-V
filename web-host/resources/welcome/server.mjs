// Example trusted server resource. Registers scoped event callbacks only; the runtime
// removes them on stop. Nothing here is sandboxed: this file is operator code.
export function start(api) {
  api.on('server:join', (e) => api.log('join ' + e.serverId + ' role=' + e.role));
  api.log('welcome server started');
}

export function stop(api) {
  api.log('welcome server stopped');
}
