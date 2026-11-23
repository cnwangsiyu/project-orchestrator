"""Descriptor-relative removal of a validated, exclusively owned scratch tree."""
import os
import stat as tree_stat


def remove_owned_tree(parent, name, expected, label):
    def validate(info, directory=False):
        if directory and not tree_stat.S_ISDIR(info.st_mode):
            raise RuntimeError(label + " symlink or non-directory refused")
        if directory and (info.st_dev, info.st_ino) != expected:
            raise RuntimeError(label + " directory identity changed")
        if info.st_uid != os.geteuid():
            raise RuntimeError(label + " owner mismatch")

    info = os.stat(name, dir_fd=parent, follow_symlinks=False)
    validate(info, directory=True)
    try:
        fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
    except PermissionError:
        # An unreadable directory cannot be opened for fchmod. Fail closed on
        # platforms without no-follow chmod rather than following a replacement.
        info = os.stat(name, dir_fd=parent, follow_symlinks=False)
        validate(info, directory=True)
        os.chmod(name, tree_stat.S_IMODE(info.st_mode) | 0o700,
                 dir_fd=parent, follow_symlinks=False)
        fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
    try:
        info = os.fstat(fd)
        validate(info, directory=True)
        if info.st_mode & 0o700 != 0o700:
            os.fchmod(fd, tree_stat.S_IMODE(info.st_mode) | 0o700)
        for entry in os.listdir(fd):
            info = os.stat(entry, dir_fd=fd, follow_symlinks=False)
            validate(info)
            if tree_stat.S_ISDIR(info.st_mode):
                remove_owned_tree(fd, entry, (info.st_dev, info.st_ino), label)
            else:
                # Parent permissions suffice; do not chmod files or link targets.
                os.unlink(entry, dir_fd=fd)
        validate(os.stat(name, dir_fd=parent, follow_symlinks=False), directory=True)
        os.rmdir(name, dir_fd=parent)
    finally:
        os.close(fd)
