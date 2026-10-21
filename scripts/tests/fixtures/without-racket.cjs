// Only the diagnostics subprocess is stubbed. Tests exercise the real server,
// parser, document synchronization, filesystem imports and JSON-RPC transport.
const childProcess = require('child_process');
const spawn = childProcess.spawn;
childProcess.spawn = (command, args, options) => {
    if (command === 'racket' && args.some(arg => arg.includes('syntax_check.rkt'))) {
        return { kill: () => true };
    }
    return spawn(command, args, options);
};
