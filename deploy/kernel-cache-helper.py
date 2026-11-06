#!/usr/bin/python3
"""Fixed, root-owned maintenance action. No command, path or parameter is read from requests."""
import os, pwd, json, time, stat

STATE='/var/lib/safehouse-maintenance'
account=pwd.getpwnam('safehouse')
base=os.open('/var/lib/safehouse',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
directory=os.open('maintenance',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=base)
try:
    request=os.stat('kernel-cache.request',dir_fd=directory,follow_symlinks=False)
    if not stat.S_ISREG(request.st_mode) or request.st_uid!=account.pw_uid:
        raise RuntimeError('Invalid maintenance request owner or file type')
    os.unlink('kernel-cache.request',dir_fd=directory)
finally:
    os.close(directory);os.close(base)

completed=lambda:round(time.time()*1000)
result={'ok':False,'completed':completed()}
try:
    try:
        with open(STATE+'/result.json') as f: previous=json.load(f)
    except FileNotFoundError: previous={}
    if completed()-previous.get('completed',0)<300000:
        raise RuntimeError('System cache reclamation is limited to once every five minutes')
    os.sync()
    with open('/proc/sys/vm/drop_caches','w') as f:f.write('3\n')
    result={'ok':True,'completed':completed(),'action':'reclaim-rebuildable-kernel-file-caches'}
except Exception as error:
    result={'ok':False,'completed':completed(),'error':str(error)}
temporary=STATE+'/result.json.new'
fd=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_TRUNC|os.O_NOFOLLOW,0o640)
with os.fdopen(fd,'w') as f:json.dump(result,f)
os.chown(temporary,0,account.pw_gid);os.chmod(temporary,0o640)
os.replace(temporary,STATE+'/result.json')
