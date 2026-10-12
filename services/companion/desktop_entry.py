"""Standalone localhost service bundled inside the desktop application."""
import argparse
import multiprocessing
import os


def main():
    multiprocessing.freeze_support()
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, required=True)
    args = parser.parse_args()
    if not 1 <= args.port <= 65535 or not os.environ.get('NICE_PEOPLE_TOKEN'):
        parser.error('A valid port and local authorization token are required')
    import uvicorn
    from server.app.api import app
    uvicorn.run(app, host='127.0.0.1', port=args.port, loop='asyncio', http='h11', ws='none', access_log=False)


if __name__ == '__main__':
    main()
