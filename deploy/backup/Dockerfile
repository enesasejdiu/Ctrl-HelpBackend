# The backup service (deploy/docker-compose.yml, README "Backups"): mysqldump/mysql and a daily schedule in bash.
# Built on the same pinned image as the db service, so the client is exactly the server's version (8.4.13), and the
# layers are already on the machine: this image only adds the script (a few KB). It never runs the MySQL server.
FROM mysql:8.4.13

# uid/gid 1000 = the API image's "node" user, which owns the uploads and backups volumes
RUN mkdir -p /backups /uploads && chown 1000:1000 /backups /uploads
COPY --chmod=755 backup.sh /usr/local/bin/backup
USER 1000:1000

ENTRYPOINT ["/usr/local/bin/backup"]
CMD ["serve"]
