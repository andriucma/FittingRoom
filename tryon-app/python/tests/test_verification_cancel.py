import asyncio
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from tryon_local import verification
from fastapi import HTTPException


class VerificationCancellationTests(unittest.IsolatedAsyncioTestCase):
    async def test_worker_returns_success_without_disconnection(self):
        spawn = asyncio.create_subprocess_exec
        async def fake_worker(*args, **kwargs):
            return await spawn(sys.executable, "-c", 'print(\'{"selected": []}\')', **kwargs)
        async def connected():
            return False
        with patch.object(verification.asyncio, "create_subprocess_exec", side_effect=fake_worker):
            result = await verification.run_worker({}, connected)
        self.assertEqual(result, {"selected": []})

    async def test_disconnect_stops_worker_and_its_decoder_child(self):
        with tempfile.TemporaryDirectory() as temp:
            marker = Path(temp) / "heartbeat"
            child = f"import time;from pathlib import Path;p=Path({str(marker)!r});\nwhile True:\n p.write_text(str(time.time()));time.sleep(.02)"
            worker = f"import subprocess,sys;subprocess.Popen([sys.executable,'-c',{child!r}]).wait()"
            spawn = asyncio.create_subprocess_exec
            processes = []
            async def fake_worker(*args, **kwargs):
                process = await spawn(sys.executable, "-c", worker, **kwargs)
                processes.append(process)
                return process
            async def disconnected():
                return marker.exists()
            with patch.object(verification.asyncio, "create_subprocess_exec", side_effect=fake_worker):
                with self.assertRaises(HTTPException) as caught:
                    await asyncio.wait_for(verification.run_worker({}, disconnected), 5)
            self.assertEqual(caught.exception.status_code, 499)
            self.assertIsNotNone(processes[0].returncode)
            stamp = marker.read_text()
            await asyncio.sleep(.15)
            self.assertEqual(marker.read_text(), stamp)


if __name__ == "__main__":
    unittest.main()
