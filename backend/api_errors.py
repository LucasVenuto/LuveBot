"""Plugin-owned API errors (contract section 7). Messages are ours and safe to show; never upstream text."""


class PluginError(Exception):
    def __init__(self, code, message, status, extra=None):
        self.code, self.message, self.status = code, message, status
        self.extra = extra or {}  # additive, ours only (e.g. the failed step); never upstream text
        super().__init__(message)
