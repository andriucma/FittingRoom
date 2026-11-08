"""Run pose analysis in a cancellable process, including its decoder process tree."""
import asyncio
import json
import os
import signal
import subprocess
import sys

from fastapi import HTTPException


async def run_worker(args, disconnected):
    if await disconnected():
        raise HTTPException(499, "Verification cancelled")
    options = {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP} if os.name == "nt" else {"start_new_session": True}
    process = await asyncio.create_subprocess_exec(
        sys.executable, "-m", "tryon_local.angle_worker", json.dumps(args),
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, **options)
    output = asyncio.create_task(process.communicate())
    try:
        while not output.done():
            if await disconnected():
                raise HTTPException(499, "Verification cancelled")
            await asyncio.wait({output}, timeout=.1)
        stdout, stderr = await output
        if process.returncode:
            raise HTTPException(422, "Couldn’t check this recording. " + stderr.decode(errors="replace")[-800:])
        return json.loads(stdout)
    finally:
        if process.returncode is None:
            if os.name == "nt":
                await asyncio.to_thread(subprocess.run, ["taskkill", "/PID", str(process.pid), "/T", "/F"],
                                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            else:
                try:
                    os.killpg(process.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
            try:
                await asyncio.wait_for(asyncio.shield(output), 3)
            except asyncio.TimeoutError:
                if os.name != "nt":
                    try:
                        os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                else:
                    process.kill()
                await output
