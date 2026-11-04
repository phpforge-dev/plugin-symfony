<?php

namespace App\Repository;

use App\Entity\Post;
use Doctrine\Bundle\DoctrineBundle\Repository\ServiceEntityRepository;
use Doctrine\Persistence\ManagerRegistry;

class PostRepository extends ServiceEntityRepository
{
    public function __construct(ManagerRegistry $registry)
    {
        parent::__construct($registry, Post::class);
    }

    public function published(): array
    {
        return $this->createQueryBuilder('p')
            ->leftJoin('p.author', 'a')
            ->andWhere('p.publishedAt IS NOT NULL')
            ->andWhere('a.email = :email')
            ->orderBy('p.titel', 'ASC')
            ->getQuery()->getResult();
    }

    public function recent(): array
    {
        return $this->findBy(['title' => 'x'], ['publishedAt' => 'DESC']);
    }
}
