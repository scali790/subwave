# Included after the programme sources exist. The idle gate stays closed until
# the controller has rebuilt today's playlist and a new request is resolved.
# No stream disconnect, process shutdown or source URI is logged.
idle_programme_generation = ref("")
idle_programme_released = ref(false)
server.register(
  "idle_reset",
  description="Discard an idle programme before a fresh scheduled start",
  usage="idle_reset <generation>",
  fun(generation) -> begin
    generation = string.trim(generation)
    if generation == "" then
      "ERROR missing generation"
    elsif not idle_mode() then
      "ERROR not idle"
    else
      idle_programme_generation := generation
      idle_programme_released := false
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
  usage="idle_resume_fresh <generation>",
  fun(generation) -> begin
    generation = string.trim(generation)
    if generation == "" or generation != idle_programme_generation() then
      "ERROR generation mismatch"
    elsif idle_programme_released() and not idle_mode() then
      # Lost reply: acknowledge the same transaction without skipping again.
      "OK"
    elsif not idle_mode() then
      "ERROR not idle"
    elsif not dj_queue.is_ready() then
      "ERROR no fresh request ready"
    else
      # Skip the actual music cross, not the currently selected blank idle
      # source. This discards the frozen outgoing audio before opening the gate.
      programme_music.skip()
      idle_mode := false
      idle_programme_released := true
      "OK"
    end
  end
)
