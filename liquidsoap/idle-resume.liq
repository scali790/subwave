# Included after the programme sources exist. The idle gate stays closed until
# the controller has rebuilt today's playlist and a new request is resolved.
# No stream disconnect, process shutdown or source URI is logged.
server.register(
  "idle_reset",
  description="Discard an idle programme before a fresh scheduled start",
  usage="idle_reset",
  fun(_) -> begin
    if not idle_mode() then
      "ERROR not idle"
    else
      dj_queue.set_queue([])
      dj_queue.skip()
      voice_queue.set_queue([])
      voice_queue.skip()
      intro_queue.set_queue([])
      intro_queue.skip()
      sfx_queue.set_queue([])
      sfx_queue.skip()
      jingle_now_queue.set_queue([])
      jingle_now_queue.skip()
      "OK"
    end
  end
)

server.register(
  "idle_resume_fresh",
  description="Release a fresh resolved programme without its old cross buffer",
  usage="idle_resume_fresh",
  fun(_) -> begin
    if not idle_mode() then
      "ERROR not idle"
    elsif not dj_queue.is_ready() then
      "ERROR no fresh request ready"
    else
      # Skip the actual music cross, not the currently selected blank idle
      # source. This discards the frozen outgoing audio before opening the gate.
      programme_music.skip()
      idle_mode := false
      "OK"
    end
  end
)
