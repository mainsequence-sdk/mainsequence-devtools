"""Exercise the real V2 terminal in a PTY; return only rendered UI evidence."""
import fcntl
import os
import pty
import re
import select
import signal
import struct
import subprocess
import sys
import termios
import time

binary, directory = sys.argv[1:3]
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 120, 0, 0))
env = dict(os.environ, TERM='xterm-256color', COLORTERM='truecolor')
process = subprocess.Popen([binary, '--standalone', directory], cwd=directory, env=env,
                           stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
os.close(slave)
output = bytearray()

def read_for(seconds):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if select.select([master], [], [], 0.05)[0]:
            try:
                data = os.read(master, 65536)
            except OSError:
                break
            output.extend(data)
            # Reply to terminal capability queries so OpenTUI initializes in a PTY.
            if b'\x1b[6n' in data:
                os.write(master, b'\x1b[1;1R')
            if b'\x1b[c' in data or b'\x1b[0c' in data:
                os.write(master, b'\x1b[?1;2c')
            if b'\x1b[>c' in data or b'\x1b[>0c' in data:
                os.write(master, b'\x1b[>0;100;0c')

try:
    read_for(6)
    os.write(master, b'/ms --help')
    read_for(0.4)
    os.write(master, b'\r')
    read_for(4)
    help_output = output.decode('utf8', 'replace')
    if 'MainSequence' not in help_output or 'Get started' not in help_output:
        # Never emit raw server logs or generated server credentials on failure.
        os.write(master, b'\x1b\x01\x0b/plugins')
        read_for(0.5)
        os.write(master, b'\r')
        read_for(1)
        os.write(master, b'\r')
        read_for(1)
        help_output = output.decode('utf8', 'replace')
        cleaned = re.sub(r'\x1b\][^\x07]*(?:\x07|\x1b\\)', '', help_output)
        cleaned = re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', cleaned)
        print('\n'.join(line for line in cleaned.splitlines() if 'password' not in line.lower())[-7000:])
        raise RuntimeError('Native /ms --help did not render the MainSequence help dialog in the terminal.')
    os.write(master, b'\x1b')
    read_for(0.3)
    invocation = os.path.join(directory, 'fixture-invocation.json')
    before_sync = os.stat(invocation).st_mtime_ns
    sync_start = len(output)
    os.write(master, b'/ms sync')
    read_for(0.4)
    os.write(master, b'\r')
    read_for(4)
    sync_output = output[sync_start:].decode('utf8', 'replace')
    if os.stat(invocation).st_mtime_ns <= before_sync or 'Dependency files were refreshed' not in sync_output:
        raise RuntimeError('Native /ms sync did not execute the SDK and render its readable result.')
    os.write(master, b'\x1b')
    read_for(0.3)
    os.write(master, b'/ms')
    read_for(0.4)
    os.write(master, b'\r')
    read_for(1)
    # With arguments enabled, the first Enter can accept slash completion;
    # the next submits the bare command and opens its menu.
    if 'Developer tools' not in output.decode('utf8', 'replace'):
        os.write(master, b'\r')
        read_for(1)
    menu_output = output.decode('utf8', 'replace')
    if 'Developer tools' not in menu_output:
        raise RuntimeError('The native MainSequence action/MCP menu did not render.')
    # Filter the native menu to verify its MCP entry without assuming scroll position.
    os.write(master, b'Connect a project MCP')
    read_for(0.5)
    if 'Connect a project MCP' not in output.decode('utf8', 'replace'):
        raise RuntimeError('The MCP connect action did not render in the native menu.')
    print('Native OpenCode terminal passed: /ms --help renders readable help; /ms sync executes the SDK and renders its result; /ms opens the grouped action and MCP menu.')
finally:
    if process.poll() is None:
        os.killpg(process.pid, signal.SIGTERM)
        try:
            process.wait(3)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait(3)
    os.close(master)
