// Example client resource. Uses only the FiveWeb client API: status line and notifications.
export function start(api) {
  api.setStatus('FiveWeb: ' + api.server.id + ' sunucusuna hoş geldin.');
  api.notify('FiveWeb hoş geldin (' + api.resource.name + ' ' + api.resource.version + ')');
  api.log('welcome client started');
}

export function stop(api) {
  api.setStatus('');
  api.log('welcome client stopped');
}
