package config

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/langchain-ai/openwiki/go/internal/constants"
)

var modelIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:/+-]*$`)

// Settings holds resolved runtime configuration.
type Settings struct {
	APIKey  string
	ModelID string
	Debug   bool
	CWD     string
}

// OpenWikiEnvDir returns ~/.openwiki.
func OpenWikiEnvDir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".openwiki"), nil
}

// OpenWikiEnvPath returns ~/.openwiki/.env.
func OpenWikiEnvPath() (string, error) {
	dir, err := OpenWikiEnvDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, ".env"), nil
}

// LoadOpenWikiEnv merges ~/.openwiki/.env into the process environment.
// Process environment values take precedence over file values.
func LoadOpenWikiEnv() error {
	path, err := OpenWikiEnvPath()
	if err != nil {
		return err
	}

	content, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}

	for key, value := range ParseEnv(string(content)) {
		if os.Getenv(key) == "" {
			_ = os.Setenv(key, value)
		}
	}

	return nil
}

// ParseEnv parses a dotenv file into key/value pairs.
func ParseEnv(content string) map[string]string {
	env := make(map[string]string)

	for _, rawLine := range strings.Split(content, "\n") {
		line := strings.TrimSpace(rawLine)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}

		equalsIndex := strings.Index(line, "=")
		if equalsIndex <= 0 {
			continue
		}

		key := strings.TrimSpace(line[:equalsIndex])
		rawValue := strings.TrimSpace(line[equalsIndex+1:])

		if !regexp.MustCompile(`^[A-Z_][A-Z0-9_]*$`).MatchString(key) {
			continue
		}

		env[key] = parseEnvValue(rawValue)
	}

	return env
}

func parseEnvValue(value string) string {
	if strings.HasPrefix(value, `"`) && strings.HasSuffix(value, `"`) && len(value) >= 2 {
		unquoted := value[1 : len(value)-1]
		unquoted = strings.ReplaceAll(unquoted, `\\`, `\`)
		unquoted = strings.ReplaceAll(unquoted, `\"`, `"`)
		unquoted = strings.ReplaceAll(unquoted, `\n`, "\n")
		return unquoted
	}
	return value
}

// NormalizeModelID trims whitespace from a model ID.
func NormalizeModelID(value string) string {
	return strings.TrimSpace(value)
}

// IsValidModelID checks whether a model ID is acceptable.
func IsValidModelID(value string) bool {
	modelID := NormalizeModelID(value)
	if modelID == "" || len(modelID) > 120 {
		return false
	}
	if strings.Contains(modelID, "://") {
		return false
	}
	return modelIDPattern.MatchString(modelID)
}

// ResolveModelID picks the model for a run.
func ResolveModelID(flagOverride string) (string, error) {
	if flagOverride != "" {
		modelID := NormalizeModelID(flagOverride)
		if !IsValidModelID(modelID) {
			return "", fmt.Errorf("invalid model ID: %s", flagOverride)
		}
		return modelID, nil
	}

	if envModel := os.Getenv(constants.OpenWikiModelIDEnv); envModel != "" {
		modelID := NormalizeModelID(envModel)
		if !IsValidModelID(modelID) {
			return "", fmt.Errorf("invalid model ID configured in %s", constants.OpenWikiModelIDEnv)
		}
		return modelID, nil
	}

	return constants.DefaultModelID, nil
}

// RequireAPIKey ensures OPENROUTER_API_KEY is set.
func RequireAPIKey() error {
	if strings.TrimSpace(os.Getenv(constants.OpenRouterAPIKeyEnv)) == "" {
		return fmt.Errorf(
			"%s is required for non-interactive runs. Set it in the environment or ~/.openwiki/.env",
			constants.OpenRouterAPIKeyEnv,
		)
	}
	return nil
}

// LoadSettings resolves configuration after env loading.
func LoadSettings(modelFlag string, cwd string) (*Settings, error) {
	if err := LoadOpenWikiEnv(); err != nil {
		return nil, err
	}

	if err := RequireAPIKey(); err != nil {
		return nil, err
	}

	modelID, err := ResolveModelID(modelFlag)
	if err != nil {
		return nil, err
	}

	if cwd == "" {
		cwd, err = os.Getwd()
		if err != nil {
			return nil, err
		}
	}

	return &Settings{
		APIKey:  os.Getenv(constants.OpenRouterAPIKeyEnv),
		ModelID: modelID,
		Debug:   os.Getenv(constants.OpenWikiDebugEnv) == "1",
		CWD:     cwd,
	}, nil
}

// IsDebugEnabled reports whether debug output is enabled.
func IsDebugEnabled() bool {
	return os.Getenv(constants.OpenWikiDebugEnv) == "1"
}
