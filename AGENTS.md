# Repository development rules

Every non-trivial change must follow the reviewed development sequence in [CONTRIBUTING.md](CONTRIBUTING.md): design and mapped test plan, independent design review, implementation by a development SubAgent, independent code review, then QA execution of the approved plan.

The Implementer must not approve its own design or code. Review and QA roles must not modify production files. The coordinating Agent owns the final judgment and must reject unsupported `PASS` verdicts.

Do not commit, push, publish, merge, or rename remotes unless the user explicitly authorizes it. Keep changes within the approved design. Run fresh, relevant verification before reporting completion.
