#!/usr/bin/env python3
"""Actual Liquidsoap 2.4.5 audio regression; only local synthetic tones.

Uses two short network-disabled containers, no host ports or live radio paths.
The unchanged frozen-resume baseline MUST retain the evening tones; the shared
production idle-resume.liq commands MUST remove them, including queued speech.
"""
import argparse
import json
import math
from pathlib import Path
import struct
import subprocess
import wave

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
out = args.output.resolve()
out.mkdir(parents=True, exist_ok=True)
rate = 44100
for name, frequency in [('evening', 220), ('queued-evening', 440), ('evening-intro', 550), ('evening-voice', 660), ('morning', 880)]:
    with wave.open(str(out / (name + '.wav')), 'wb') as wav:
        wav.setnchannels(2); wav.setsampwidth(2); wav.setframerate(rate)
        wav.writeframes(b''.join(struct.pack('<hh', *([int(5000 * math.sin(2 * math.pi * frequency * i / rate))] * 2)) for i in range(rate * 30)))

base = '''settings.log.stdout.set(true)
dj_queue = request.queue(queue=[request.create("/lab/evening.wav"),request.create("/lab/queued-evening.wav")])
voice_queue = request.queue(queue=[request.create("/lab/evening-voice.wav")])
intro_queue = request.queue(queue=[request.create("/lab/evening-intro.wav")])
sfx_queue = request.queue()
jingle_now_queue = request.queue()
programme_music = crossfade(duration=2., fallback(track_sensitive=false, [dj_queue, blank()]))
programme = add(normalize=false,[programme_music,voice_queue,intro_queue])
idle_mode = ref(false)
phase = ref(0)
s = switch(track_sensitive=false,[({idle_mode()},blank()),({true},programme)])
output.file(fallible=true, %wav, "/lab/OUTPUT.wav", s)
INCLUDE
t=time()
def tick() =
 elapsed=time()-t
 if elapsed>2. and phase()==0 then
  idle_mode:=true
  phase:=1
 elsif elapsed>4. and phase()==1 then
  PREPARE
  phase:=2
 elsif phase()==2 and dj_queue.is_ready() then
  RELEASE
  phase:=3
 elsif elapsed>12. then
  shutdown()
 end
end
thread.run(every=0.1,tick)
'''
results = {}
for mode in ['baseline', 'candidate']:
    candidate = mode == 'candidate'
    script = base.replace('OUTPUT', mode).replace('INCLUDE', '%include "/source/liquidsoap/idle-resume.liq"' if candidate else '')
    script = script.replace('PREPARE', 'ignore(server.execute("idle_reset"))\n  ignore(dj_queue.push(request.create("/lab/morning.wav")))' if candidate else 'ignore(dj_queue.push(request.create("/lab/morning.wav")))')
    script = script.replace('RELEASE', 'ignore(server.execute("idle_resume_fresh"))' if candidate else 'idle_mode:=false')
    (out / (mode + '.liq')).write_text(script, encoding='utf-8')
    cmd = ['docker', 'run', '--rm', '--name', 'subwave-idle-audio-' + mode,
           '--network', 'none', '--cpus', '2', '--entrypoint', 'liquidsoap',
           '--mount', f'type=bind,source={ROOT},target=/source,readonly',
           '--mount', f'type=bind,source={out},target=/lab',
           'savonet/liquidsoap:v2.4.5', '/lab/' + mode + '.liq']
    try:
        run = subprocess.run(cmd, capture_output=True, text=True, timeout=40)
    except subprocess.TimeoutExpired:
        subprocess.run(['docker', 'kill', 'subwave-idle-audio-' + mode], capture_output=True, timeout=10)
        raise
    (out / (mode + '.log')).write_text(run.stdout + run.stderr, encoding='utf-8')
    if run.returncode:
        raise RuntimeError(f'{mode} Liquidsoap failed; see {out / (mode + ".log")}')
    with wave.open(str(out / (mode + '.wav'))) as wav:
        channels = wav.getnchannels(); sample_rate = wav.getframerate()
        data = wav.readframes(wav.getnframes())
    samples = struct.unpack('<' + 'h' * (len(data) // 2), data)[::channels]
    def level(t, frequency):
        window = samples[int(t * sample_rate):int((t + .25) * sample_rate)]
        return 2 * math.hypot(sum(x * math.cos(2 * math.pi * frequency * i / sample_rate) for i, x in enumerate(window)),
                             sum(x * math.sin(2 * math.pi * frequency * i / sample_rate) for i, x in enumerate(window))) / max(1, len(window))
    scan = [{'at_seconds': t, 'old_peak': max(level(t, f) for f in [220, 440, 550, 660]), 'morning': level(t, 880)}
            for t in [4.5, 5., 5.5, 6., 6.5, 7., 7.5, 8., 9., 10., 11.]]
    results[mode] = scan
    if candidate:
        assert max(s['old_peak'] for s in scan) < 100, 'old music/speech leaked after a fresh resume'
        assert max(s['morning'] for s in scan) > 1000, 'fresh morning audio never became audible'
    else:
        assert max(s['old_peak'] for s in scan) > 1000, 'baseline did not reproduce frozen evening audio'
(out / 'audio-results.json').write_text(json.dumps(results, indent=2), encoding='utf-8')
print('PASS: baseline reproduces evening audio; production resume commands remove evening music, queued tracks and speech; morning tone audible.')
