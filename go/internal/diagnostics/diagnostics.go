package diagnostics

import (
	"os"
	"regexp"
	"strings"

	"github.com/langchain-ai/openwiki/go/internal/constants"
)

var (
	bearerPattern      = regexp.MustCompile(`\bBearer\s+[A-Za-z0-9._~+/=-]+`)
	skOrPattern        = regexp.MustCompile(`\bsk-or-v1-[A-Za-z0-9_-]+`)
	skPattern          = regexp.MustCompile(`\bsk-[A-Za-z0-9_-]+`)
	lsPattern          = regexp.MustCompile(`\bls[v_][A-Za-z0-9_-]+`)
	incorrectKeyPattern = regexp.MustCompile(`(?i)(Incorrect API key provided:\s*)([^\s.]+)`)
	openRouterErrPattern = regexp.MustCompile(`(?i)OpenRouterError`)
	internalServerPattern = regexp.MustCompile(`(?i)Internal Server Error`)
	status500Pattern     = regexp.MustCompile(`\b500\b`)
)

// SanitizeDiagnosticText redacts secrets from text before display.
func SanitizeDiagnosticText(value string) string {
	sanitized := value

	for _, key := range []string{
		constants.OpenRouterAPIKeyEnv,
		"LANGSMITH_API_KEY",
	} {
		secret := os.Getenv(key)
		if secret != "" {
			sanitized = strings.ReplaceAll(sanitized, secret, "[REDACTED:"+key+"]")
		}
	}

	sanitized = incorrectKeyPattern.ReplaceAllString(sanitized, "${1}[REDACTED:API_KEY]")
	sanitized = bearerPattern.ReplaceAllString(sanitized, "Bearer [REDACTED]")
	sanitized = skOrPattern.ReplaceAllString(sanitized, "[REDACTED:OPENROUTER_API_KEY]")
	sanitized = skPattern.ReplaceAllString(sanitized, "[REDACTED:API_KEY]")
	sanitized = lsPattern.ReplaceAllString(sanitized, "[REDACTED:LANGSMITH_API_KEY]")

	return sanitized
}

// IsOpenRouterServerError detects provider 500 responses.
func IsOpenRouterServerError(err error, message string) bool {
	if err == nil {
		return false
	}

	msg := message
	if msg == "" {
		msg = err.Error()
	}

	if openRouterErrPattern.MatchString(msg) ||
		(internalServerPattern.MatchString(msg) && status500Pattern.MatchString(msg)) {
		return true
	}

	return false
}

// GetErrorMessage returns a user-facing error message with secrets redacted.
func GetErrorMessage(err error) string {
	if err == nil {
		return "OpenWiki agent run failed."
	}

	message := err.Error()
	if IsOpenRouterServerError(err, message) {
		return "OpenRouter/provider returned 500 Internal Server Error. Try retrying or switching models. Run with OPENWIKI_DEBUG=1 to show provider metadata."
	}

	return SanitizeDiagnosticText(message)
}
