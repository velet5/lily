//! Lily Studio's agent chats (DECISIONS D40, D41): Claude Code and Codex, run
//! headless in the open folder, one process per turn, and the chats that keep
//! what they said and did. No Tauri here, so `cargo test -p lily-agents` runs
//! it all; the app adds the dialogs, the settings and the IPC.

pub mod agent_chats;
pub mod agents;
pub mod chats;
mod js;

pub use agent_chats::{
    AgentChats, AgentChatsOptions, ChatEvent, ChatInfo, ChatMessage, MAX_IMAGE_BYTES, MAX_IMAGES,
    OpenChat, PastedImage, chat_images_dir,
};
pub use agents::{
    AGENTS, Agent, AgentEvent, AgentId, AgentRun, AgentState, AgentStatus, Ask, ChatEntry,
    Decision, DetectAgentOptions, Env, Permission, Role, RunOptions, Selection, TurnOptions,
    agent_args, agent_env, agent_input, agent_label, agent_out_dir, agent_path, ask_answer,
    detect_agent, is_agent_id, login_shell_path, process_env, run_agent,
};
pub use chats::{Chat, ChatStore, ChatSummary, MAX_CHATS, chat_title};
