class_name ServerUrl
extends RefCounted
## Classifies a server address, so the app can say something useful about it
## before the connection is refused.
##
## The device secret travels in the first frame, so `ws://` to anything but
## this machine hands it to whoever is on the path. The server refuses those
## connections (server/src/net/tls.ts); this is the client half - saying so
## in advance rather than leaving the player with an opaque rejection.
##
## Pure string work, kept out of the autoload so it can be tested directly.

const LOCAL_HOSTS := ["localhost", "127.0.0.1", "::1", "[::1]"]


static func is_secure(url: String) -> bool:
	return url.strip_edges().to_lower().begins_with("wss://")


## The host part, lowercased, without scheme, port or path.
static func host_of(url: String) -> String:
	var rest := url.strip_edges().to_lower()
	for scheme in ["wss://", "ws://"]:
		if rest.begins_with(scheme):
			rest = rest.substr(scheme.length())
			break

	# Trim the path, then the port - but not the colons inside an IPv6 literal.
	var slash := rest.find("/")
	if slash >= 0:
		rest = rest.substr(0, slash)
	if rest.begins_with("["):
		var close := rest.find("]")
		if close >= 0:
			return rest.substr(0, close + 1)
	var colon := rest.rfind(":")
	if colon >= 0:
		rest = rest.substr(0, colon)
	return rest


static func is_local(url: String) -> bool:
	return LOCAL_HOSTS.has(host_of(url))


static func is_valid(url: String) -> bool:
	var trimmed := url.strip_edges().to_lower()
	if not (trimmed.begins_with("ws://") or trimmed.begins_with("wss://")):
		return false
	return not host_of(url).is_empty()


## Empty when the address is fine to use; otherwise what is wrong with it,
## in words meant for a player rather than an operator.
static func risk_of(url: String) -> String:
	if not is_valid(url):
		return "That does not look like a server address. It should start with wss://"
	if is_secure(url) or is_local(url):
		return ""
	return "Insecure address. Anything but wss:// sends this device's credentials " \
		+ "in the clear, and the server will refuse the connection."


## The address most likely intended: a bare host, or one typed with http(s).
## Returns the input unchanged when there is nothing sensible to do.
static func normalise(url: String) -> String:
	var trimmed := url.strip_edges()
	if trimmed.is_empty():
		return trimmed

	var lower := trimmed.to_lower()
	if lower.begins_with("https://"):
		return "wss://" + trimmed.substr(8)
	if lower.begins_with("http://"):
		return "ws://" + trimmed.substr(7)
	if lower.begins_with("ws://") or lower.begins_with("wss://"):
		return trimmed

	# No scheme at all: assume the secure one, which is the one they want.
	return "wss://" + trimmed
