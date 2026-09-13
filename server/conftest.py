import os
os.environ["ENV_FILE"] = "/nonexistent"
os.environ["DATABASE_URL"] = "sqlite:///:memory:"
os.environ["SPACE_STANDALONE"] = "true"
os.environ["SPACE_JOIN_TICKET_SECRET"] = "development-test-join-ticket-secret"
