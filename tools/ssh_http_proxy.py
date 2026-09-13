#!/usr/bin/env python3
"""Binary-safe SSH ProxyCommand through the required local HTTP CONNECT proxy."""
import os
import select
import socket
import sys


def main():
    host, port = sys.argv[1:]
    if not port.isdigit() or any(c in host for c in '\r\n '):
        raise SystemExit('Invalid target')
    with socket.create_connection(('127.0.0.1', 19100), timeout=15) as connection:
        connection.sendall(f'CONNECT {host}:{port} HTTP/1.1\r\nHost: {host}:{port}\r\n\r\n'.encode())
        response = bytearray()
        while not response.endswith(b'\r\n\r\n'):
            chunk = connection.recv(1)
            if not chunk or len(response) > 65536:
                raise SystemExit('Proxy closed before CONNECT response')
            response.extend(chunk)
        if response.split(b'\r\n', 1)[0].split()[1] != b'200':
            raise SystemExit('Proxy rejected CONNECT')
        connection.settimeout(None)
        sources = [connection, sys.stdin.buffer]
        while sources:
            ready, _, _ = select.select(sources, [], [])
            for source in ready:
                data = connection.recv(65536) if source is connection else os.read(0, 65536)
                if not data:
                    if source is connection:
                        return
                    sources.remove(source)
                    connection.shutdown(socket.SHUT_WR)
                elif source is connection:
                    sys.stdout.buffer.write(data)
                    sys.stdout.buffer.flush()
                else:
                    connection.sendall(data)

if __name__ == '__main__':
    main()
