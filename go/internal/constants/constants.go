package constants

const (
	OpenWikiDir         = "openwiki"
	UpdateMetadataPath  = "openwiki/.last-update.json"
	OpenRouterAPIKeyEnv = "OPENROUTER_API_KEY"
	OpenWikiModelIDEnv  = "OPENWIKI_MODEL_ID"
	OpenWikiDebugEnv    = "OPENWIKI_DEBUG"
	OpenRouterBaseURL   = "https://openrouter.ai/api/v1"
	DefaultModelID      = "z-ai/glm-5.2"
	OpenWikiVersion     = "0.0.2-go"
	MaxAgentIterations  = 50
	ShellTimeoutSeconds = 120
	MaxShellOutputBytes = 100_000
)

// Command identifies the OpenWiki run mode.
type Command string

const (
	CommandInit Command = "init"
	CommandUpdate Command = "update"
	CommandChat Command = "chat"
)
